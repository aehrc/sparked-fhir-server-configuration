/**
 * Unit tests for module-config/smart-post-authorize.js.
 *
 * The post-authorize script runs on every SMART login on aucore (Inferno,
 * connectathon users, Platypus, sandboxes), and aucore is the only Smile CDR
 * node, so this is the only test a change gets before it reaches that node.
 * This loads the real script into a sandbox with stubbed Log and Converter
 * globals and drives onTokenGenerating and onSmartLoginPreContextSelection with
 * mock Smile CDR objects.
 *
 * What this can and cannot prove: the claim rule and the picker's scoping are
 * covered exactly, but the accessor names (getApprovedScopes, oidcClientId,
 * defaultLaunchContexts) and whether the approved scopes are populated at
 * context selection and at token generation come from the Smile CDR
 * documentation, not from a measurement. The Java-shaped mocks (strictJavaSet,
 * strictJavaMap, javaShapedSession) model what Smile CDR's GraalJS engine hands
 * the script: Java objects with their own methods and no JS array methods. They
 * fail any read of a member a Java Set or Map does not have, so they prove the
 * script asks the scopes only through Java methods, but node is not GraalJS:
 * host-object behaviour (typeof on host members, property access to getters)
 * is not reproduced. The live check after the pod rolls, with the sandbox
 * diagnostic log line, is what settles that.
 *
 * Run: node scripts/test_smart_post_authorize.js
 * No dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'module-config', 'smart-post-authorize.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

const AUD = 'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT';

let failures = 0;
let passes = 0;

/** Load a fresh copy of the post-authorize script. */
function load() {
  const logs = [];
  const context = {
    Log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    Converter: {
      // Smile CDR's base64Decode accepts base64 and base64url; Buffer does both.
      base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: SCRIPT });
  return { context, logs };
}

/** A launch token as an EHR would mint it: base64 of a JSON object. */
function launchToken(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Mock java.util.Set<String>: contains, size, an iterator and toString, nothing else. */
function javaSet(items) {
  return {
    contains: (x) => items.includes(x),
    size: () => items.length,
    iterator: () => {
      let i = 0;
      return { hasNext: () => i < items.length, next: () => items[i++] };
    },
    toString: () => '[' + items.join(', ') + ']',
  };
}

/**
 * A java.util.Set<String> as GraalJS hands it to the script: only the Java
 * methods. Reading any other member (indexOf, includes, length, a numeric
 * index) is recorded in `misses` and throws, as a JS array method would fail
 * on the real host object. Both forms of toString conversion are allowed.
 */
function strictJavaSet(items, misses) {
  const allowed = new Set(['contains', 'size', 'iterator', 'toString']);
  return new Proxy(javaSet(items), {
    get(target, prop) {
      if (typeof prop === 'symbol' || allowed.has(prop)) {
        return target[prop];
      }
      if (misses) {
        misses.push(String(prop));
      }
      throw new TypeError('java.util.HashSet has no member ' + String(prop));
    },
  });
}

/** A java.util.Map<String,String> as GraalJS hands it: get() only. */
function strictJavaMap(entries, misses) {
  return new Proxy({ get: (k) => (k in entries ? entries[k] : null) }, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'get') {
        return target[prop];
      }
      if (misses) {
        misses.push(String(prop));
      }
      throw new TypeError('java.util.HashMap has no member ' + String(prop));
    },
  });
}

/** Mock java.util.List. */
function javaList(items) {
  return {
    size: () => items.length,
    get: (i) => items[i],
    iterator: () => {
      let i = 0;
      return { hasNext: () => i < items.length, next: () => items[i++] };
    },
  };
}

/**
 * Mock UserSessionDetails. `approvedScopes` is a space-separated string turned
 * into a Java set, or undefined to leave the property unreadable.
 */
function userSession(opts) {
  const o = opts || {};
  const calls = { launchResourceIds: [], fhirUser: [] };
  const contexts = o.contexts || [];
  const session = {
    oidcClientId: o.clientId,
    defaultLaunchContexts: javaList(contexts),
    addLaunchResourceId: (k, v) => calls.launchResourceIds.push([k, v]),
    setFhirUserUrl: (u) => calls.fhirUser.push(u),
    getOrCreateDefaultLaunchContext: (type) =>
      contexts.find((c) => c.contextType === type) || { contextType: type, resourceId: null },
  };
  if (o.approvedScopes !== undefined) {
    session.approvedScopes = javaSet(o.approvedScopes.split(' ').filter(Boolean));
  }
  return { session, calls };
}

/** Mock AuthorizationRequestDetails. */
function requestDetails(opts) {
  const o = opts || {};
  const calls = { claims: [] };
  const params = o.params || {};
  // Claims Smile CDR already holds for this token (from a granted launch/<key>).
  const held = o.smileHolds || [];
  const details = {
    getAudience: () => (o.audience === undefined ? AUD : o.audience),
    getLaunch: () => o.launch || null,
    getRequestParameters: () => (o.javaMaps ? strictJavaMap(params, o.misses) : { get: (k) => (k in params ? params[k] : null) }),
    addAccessTokenClaim: (k, v) => {
      // Smile CDR refuses a claim it already holds (validateDontAlreadyHaveClaim).
      if (held.includes(k) || calls.claims.some(([key]) => key === k)) {
        throw new Error('IllegalArgumentException: duplicate claim ' + k);
      }
      calls.claims.push([k, v]);
    },
  };
  return { details, calls };
}

/** Mock ContextSelectionChoices recording every call made on it. */
function contextChoices() {
  const persons = [];
  const other = [];
  const choices = {
    addPerson: () => {
      const p = {};
      persons.push(p);
      return p;
    },
  };
  for (const name of ['addAuthority', 'addRequestedScopes', 'addAutoGrantScopes',
    'removeAuthority', 'removeRequestedScopes', 'removeAutoGrantScopes']) {
    choices[name] = (...args) => other.push([name, args]);
  }
  return { choices, persons, other };
}

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes++;
    console.log(`[PASS] ${name}`);
  } else {
    failures++;
    console.log(`[FAIL] ${name}: got ${a}, expected ${e}`);
  }
}

function checkLog(name, logs, needle, shouldMatch) {
  const found = logs.some(([, message]) => String(message).includes(needle));
  if (found === shouldMatch) {
    passes++;
    console.log(`[PASS] ${name}`);
  } else {
    failures++;
    console.log(`[FAIL] ${name}: ${shouldMatch ? 'expected' : 'did not expect'} a log line containing "${needle}"`);
    logs.forEach(([level, message]) => console.log(`         ${level}: ${message}`));
  }
}

/** Run onTokenGenerating and return the claims, launch ids and fhirUser set. */
function token(sessionOpts, requestOpts) {
  const loaded = load();
  const s = sessionOpts === null ? null : userSession(sessionOpts);
  const r = requestDetails(requestOpts);
  let error = null;
  try {
    loaded.context.onTokenGenerating(s ? s.session : null, r.details);
  } catch (e) {
    error = String(e);
  }
  return {
    error,
    claims: r.calls.claims,
    launchResourceIds: s ? s.calls.launchResourceIds : [],
    fhirUser: s ? s.calls.fhirUser : [],
    logs: loaded.logs,
  };
}

/** Run onSmartLoginPreContextSelection and return what it added. */
function pick(session) {
  const loaded = load();
  const c = contextChoices();
  let error = null;
  try {
    loaded.context.onSmartLoginPreContextSelection(session, c.choices);
  } catch (e) {
    error = String(e);
  }
  return { error, persons: c.persons, other: c.other, logs: loaded.logs };
}

const practitionerCtx = { contextType: 'practitioner', resourceId: 'Practitioner/guthridge-jarred' };

// ---------------------------------------------------------------------------
// onTokenGenerating: flows that do not change
// ---------------------------------------------------------------------------

console.log('--- token: unchanged flows ---');

let t = token(null, { params: { scope: 'system/*.read' } });
check('client credentials (no user session) does nothing and does not throw',
  [t.error, t.claims], [null, []]);

t = token({ approvedScopes: 'openid fhirUser launch/patient patient/*.read', contexts: [practitionerCtx] }, {});
check('standalone launch sets fhirUser from the practitioner default context',
  t.fhirUser, [AUD + '/Practitioner/guthridge-jarred']);
check('standalone launch adds no claim and no launch resource id',
  [t.claims, t.launchResourceIds], [[], []]);

t = token({ approvedScopes: 'openid fhirUser launch/patient', contexts: [practitionerCtx] }, { audience: AUD + '/' });
check('a trailing slash on the audience is normalised',
  t.fhirUser, [AUD + '/Practitioner/guthridge-jarred']);

// ---------------------------------------------------------------------------
// onTokenGenerating: EHR launch claim rule
// ---------------------------------------------------------------------------

console.log('--- token: EHR launch claim rule ---');

t = token({ approvedScopes: 'openid fhirUser launch patient/*.read', contexts: [practitionerCtx] },
  { launch: launchToken({ patient: 'pat-1' }) });
check('EHR launch with "launch" adds the patient claim (today\'s behaviour)',
  t.claims, [['patient', 'pat-1']]);
check('EHR launch with "launch" adds the patient launch resource id',
  t.launchResourceIds, [['patient', 'pat-1']]);
check('EHR launch with no practitioner in the token falls back to the default context',
  t.fhirUser, [AUD + '/Practitioner/guthridge-jarred']);

t = token({ approvedScopes: 'openid fhirUser launch launch/patient patient/*.read' },
  { launch: launchToken({ patient: 'pat-1' }) });
check('EHR launch with "launch launch/patient" adds the launch resource id',
  t.launchResourceIds, [['patient', 'pat-1']]);
check('EHR launch with "launch launch/patient" does not add the patient claim (Smile adds it)',
  t.claims, []);
check('EHR launch with "launch launch/patient" does not throw', t.error, null);

t = token({ approvedScopes: 'openid launch launch/patient launch/encounter' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }) });
check('EHR launch with launch/encounter adds both launch resource ids',
  t.launchResourceIds, [['patient', 'pat-1'], ['encounter', 'enc-1']]);
check('EHR launch with launch/patient and launch/encounter adds neither claim',
  t.claims, []);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }) });
check('EHR launch without launch/encounter still adds the encounter claim',
  t.claims, [['encounter', 'enc-1']]);
check('EHR launch without launch/encounter adds both launch resource ids',
  t.launchResourceIds, [['patient', 'pat-1'], ['encounter', 'enc-1']]);

t = token({ approvedScopes: 'openid launch launch/encounter' },
  { launch: launchToken({ encounter: 'enc-1' }) });
check('EHR launch with "launch launch/encounter" does not add the encounter claim',
  [t.claims, t.launchResourceIds], [[], [['encounter', 'enc-1']]]);

t = token({ approvedScopes: 'openid launch' },
  { launch: launchToken({ encounter: 'enc-1' }) });
check('EHR launch with "launch" adds the encounter claim (today\'s behaviour)',
  [t.claims, t.launchResourceIds], [[['encounter', 'enc-1']], [['encounter', 'enc-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { launch: launchToken({ patient: 'pat-1', practitioner: 'smith-jane' }) });
check('a practitioner in the launch token sets fhirUser',
  t.fhirUser, [AUD + '/Practitioner/smith-jane']);
check('a practitioner in the launch token is never a claim or launch resource id',
  [t.claims, t.launchResourceIds], [[], [['patient', 'pat-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { params: { launch: launchToken({ patient: 'pat-1' }) } });
check('a launch token from the whitelisted request parameter follows the same rule',
  [t.claims, t.launchResourceIds], [[], [['patient', 'pat-1']]]);

// ---------------------------------------------------------------------------
// onTokenGenerating: reading the scopes
// ---------------------------------------------------------------------------

console.log('--- token: reading the scopes ---');

t = token({}, { launch: launchToken({ patient: 'pat-1' }) });
check('approved scopes unreadable and no scope parameter keeps today\'s behaviour',
  [t.claims, t.launchResourceIds], [[['patient', 'pat-1']], [['patient', 'pat-1']]]);

t = token({}, { launch: launchToken({ patient: 'pat-1' }), params: { scope: 'openid  launch\tlaunch/patient' } });
check('approved scopes unreadable falls back to the whitelisted scope parameter',
  [t.claims, t.launchResourceIds], [[], [['patient', 'pat-1']]]);

t = token({ approvedScopes: '' }, { launch: launchToken({ patient: 'pat-1' }), params: { scope: 'launch launch/patient' } });
check('an empty approved scope set falls back to the scope parameter',
  t.claims, []);

{
  const loaded = load();
  const s = userSession({});
  Object.defineProperty(s.session, 'approvedScopes', { get: () => { throw new Error('no such property'); } });
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('an approvedScopes accessor that throws keeps today\'s behaviour',
    [error, r.calls.claims], [null, [['patient', 'pat-1']]]);
}

{
  const loaded = load();
  const s = userSession({});
  s.session.getApprovedScopes = () => javaSet(['launch', 'launch/patient']);
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  loaded.context.onTokenGenerating(s.session, r.details);
  check('approved scopes are read through getApprovedScopes() when the property is absent',
    r.calls.claims, []);
}

{
  // Smile CDR never hands a JS array; one has no contains(), so it is unknown
  // and the request parameter decides.
  const loaded = load();
  const s = userSession({});
  s.session.approvedScopes = ['openid', 'launch', 'launch/patient'];
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }), params: { scope: 'openid launch launch/patient' } });
  loaded.context.onTokenGenerating(s.session, r.details);
  check('approved scopes given as a JS array count as unknown, and the request decides', r.calls.claims, []);
}

{
  const loaded = load();
  const s = userSession({});
  s.session.approvedScopes = ['openid', 'launch', 'launch/patient'];
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  loaded.context.onTokenGenerating(s.session, r.details);
  check('approved scopes given as a JS array with no request parameter add the claim', r.calls.claims, [['patient', 'pat-1']]);
}

{
  // The Java-shaped twin of the case above.
  const loaded = load();
  const s = userSession({});
  s.session.approvedScopes = strictJavaSet(['openid', 'launch', 'launch/patient']);
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  loaded.context.onTokenGenerating(s.session, r.details);
  check('approved scopes given as a Java set field (no getter) are read', r.calls.claims, []);
}

t = token({ approvedScopes: 'openid launch launch/patient-extra' }, { launch: launchToken({ patient: 'pat-1' }) });
check('a scope that only starts with launch/patient is not launch/patient',
  t.claims, [['patient', 'pat-1']]);

// ---------------------------------------------------------------------------
// onTokenGenerating: which scope sources decide the skip
// ---------------------------------------------------------------------------

console.log('--- token: approved scopes against the request parameter ---');

// Approved scopes may carry approvals remembered from an earlier consent.
t = token({ approvedScopes: 'openid launch launch/patient' },
  { launch: launchToken({ patient: 'pat-1' }), params: { scope: 'launch openid' } });
check('a remembered launch/patient approval this request did not ask for still adds the claim',
  [t.error, t.claims, t.launchResourceIds], [null, [['patient', 'pat-1']], [['patient', 'pat-1']]]);

t = token({ approvedScopes: 'openid launch' },
  { launch: launchToken({ patient: 'pat-1' }), params: { scope: 'openid launch launch/patient' } });
check('launch/patient requested but not approved (declined) adds the claim',
  t.claims, [['patient', 'pat-1']]);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { launch: launchToken({ patient: 'pat-1' }), params: { scope: 'openid launch launch/patient' } });
check('launch/patient both approved and requested skips the claim',
  [t.error, t.claims, t.launchResourceIds], [null, [], [['patient', 'pat-1']]]);

{
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid launch launch/patient' });
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  r.details.getRequestParameters = () => { throw new Error('no request parameters'); };
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('request parameters unreadable and launch/patient approved skips the claim',
    [error, r.calls.claims, s.calls.launchResourceIds], [null, [], [['patient', 'pat-1']]]);
}

t = token({}, { launch: launchToken({ patient: 'pat-1' }), params: {} });
check('neither approved scopes nor the scope parameter readable adds the claim',
  [t.error, t.claims], [null, [['patient', 'pat-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient launch/encounter' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }), params: { scope: 'openid launch launch/encounter' } });
check('each key is decided on its own: only the scope in both sources is skipped',
  t.claims, [['patient', 'pat-1']]);

// ---------------------------------------------------------------------------
// onTokenGenerating: launch JSON that is not an object
// ---------------------------------------------------------------------------

console.log('--- token: launch JSON that is not an object (same as main) ---');

function rawLaunch(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

t = token({ approvedScopes: 'openid launch', contexts: [practitionerCtx] }, { launch: rawLaunch('null') });
check('launch JSON null throws the same TypeError as before and adds nothing',
  [t.error, t.claims, t.launchResourceIds, t.fhirUser],
  ['TypeError: Cannot convert undefined or null to object', [], [], []]);

t = token({ approvedScopes: 'openid launch', contexts: [practitionerCtx] }, { launch: rawLaunch('7') });
check('launch JSON number adds nothing and falls back to the default practitioner',
  [t.error, t.claims, t.launchResourceIds, t.fhirUser],
  [null, [], [], [AUD + '/Practitioner/guthridge-jarred']]);

t = token({ approvedScopes: 'openid launch', contexts: [practitionerCtx] }, { launch: rawLaunch('["a","b"]') });
check('launch JSON array is read key by key, as before',
  [t.error, t.claims, t.launchResourceIds, t.fhirUser],
  [null, [['0', 'a'], ['1', 'b'], ['length', 2]], [['0', 'a'], ['1', 'b'], ['length', 2]],
    [AUD + '/Practitioner/guthridge-jarred']]);

t = token({ approvedScopes: 'openid launch', contexts: [practitionerCtx] }, { launch: rawLaunch('"ab"') });
check('launch JSON string is read character by character, as before',
  [t.error, t.claims, t.launchResourceIds, t.fhirUser],
  [null, [['0', 'a'], ['1', 'b'], ['length', 2]], [['0', 'a'], ['1', 'b'], ['length', 2]],
    [AUD + '/Practitioner/guthridge-jarred']]);

// ---------------------------------------------------------------------------
// onTokenGenerating: fhirUser from a sandbox's sbx-fhiruser context
// ---------------------------------------------------------------------------

console.log('--- token: sbx-fhiruser fallback ---');

// aehrc/sparked-sandbox writes this context, and no practitioner context, on a
// login whose deployment names a Patient as fhirUser.
const sbxPatientFhirUser = { contextType: 'sbx-fhiruser', resourceId: 'Patient/abc123-pat-1' };

t = token({ approvedScopes: 'openid fhirUser launch/patient', contexts: [sbxPatientFhirUser] }, {});
check('standalone with sbx-fhiruser Patient/... and no practitioner sets fhirUser to that Patient',
  [t.error, t.fhirUser], [null, [AUD + '/Patient/abc123-pat-1']]);

t = token({ approvedScopes: 'openid fhirUser', contexts: [sbxPatientFhirUser] },
  { audience: 'https://smile.sparked-fhir.com/aucore/fhir/VENDOR-A/' });
check('the sbx-fhiruser reference is put under the (normalised) audience',
  t.fhirUser, ['https://smile.sparked-fhir.com/aucore/fhir/VENDOR-A/Patient/abc123-pat-1']);

t = token({ approvedScopes: 'openid fhirUser', contexts: [sbxPatientFhirUser, practitionerCtx] }, {});
check('a practitioner context wins over sbx-fhiruser',
  t.fhirUser, [AUD + '/Practitioner/guthridge-jarred']);

t = token({ approvedScopes: 'openid fhirUser launch', contexts: [sbxPatientFhirUser] },
  { launch: launchToken({ patient: 'pat-1' }) });
check('EHR launch without a practitioner key falls back to sbx-fhiruser',
  [t.error, t.fhirUser, t.launchResourceIds], [null, [AUD + '/Patient/abc123-pat-1'], [['patient', 'pat-1']]]);

t = token({ approvedScopes: 'openid fhirUser launch', contexts: [sbxPatientFhirUser] },
  { launch: launchToken({ patient: 'pat-1', practitioner: 'smith-jane' }) });
check('EHR launch with a practitioner key ignores sbx-fhiruser',
  t.fhirUser, [AUD + '/Practitioner/smith-jane']);

t = token({ approvedScopes: 'openid fhirUser',
  contexts: [{ contextType: 'sbx-fhiruser', resourceId: 'Practitioner/abc123-prac-1' }] }, {});
check('sbx-fhiruser may name a Practitioner',
  t.fhirUser, [AUD + '/Practitioner/abc123-prac-1']);

t = token({ approvedScopes: 'openid fhirUser',
  contexts: [{ contextType: 'SBX-FhirUser', resourceId: 'Patient/abc123-pat-1' }] }, {});
check('the sbx-fhiruser context type matches case-insensitively',
  t.fhirUser, [AUD + '/Patient/abc123-pat-1']);

for (const type of ['sbx-fhiruser-2', 'fhiruser', 'my-sbx-fhiruser', 'patient']) {
  t = token({ approvedScopes: 'openid fhirUser', contexts: [{ contextType: type, resourceId: 'Patient/abc123-pat-1' }] }, {});
  check(`a context of type ${type} is not sbx-fhiruser and sets nothing`, t.fhirUser, []);
}

for (const resourceId of ['abc123-pat-1', 'Organization/x', 'Patient/a/b', 'Patient/a b', 'patient/abc123-pat-1',
  'Patient/', '', null, 'Patient/' + 'a'.repeat(65), ' Patient/abc123-pat-1', 'Patient/abc123-pat-1\n',
  '../Patient/x', 'Patient/x?_format=json']) {
  t = token({ approvedScopes: 'openid fhirUser', contexts: [{ contextType: 'sbx-fhiruser', resourceId }] }, {});
  check(`a malformed sbx-fhiruser resource id ${JSON.stringify(resourceId)} sets nothing`,
    [t.error, t.fhirUser], [null, []]);
}

t = token({ approvedScopes: 'openid fhirUser',
  contexts: [{ contextType: 'sbx-fhiruser', resourceId: 'Patient/' + 'a'.repeat(64) }] }, {});
check('a 64-character id is accepted', t.fhirUser, [AUD + '/Patient/' + 'a'.repeat(64)]);

t = token({ approvedScopes: 'openid fhirUser', contexts: [
  { contextType: 'sbx-fhiruser', resourceId: 'Organization/x' },
  { contextType: 'sbx-fhiruser', resourceId: 'Patient/abc123-pat-1' },
] }, {});
check('only the first sbx-fhiruser context counts', t.fhirUser, []);

{
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid fhirUser' });
  s.session.defaultLaunchContexts = javaList([
    { getContextType: () => 'sbx-fhiruser', getResourceId: () => 'Patient/abc123-pat-1' },
  ]);
  loaded.context.onTokenGenerating(s.session, requestDetails({}).details);
  check('the sbx-fhiruser context is read through its getters', s.calls.fhirUser, [AUD + '/Patient/abc123-pat-1']);
}

{
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid fhirUser' });
  s.session.defaultLaunchContexts = [sbxPatientFhirUser];
  loaded.context.onTokenGenerating(s.session, requestDetails({}).details);
  check('default launch contexts given as a JS array are read for sbx-fhiruser',
    s.calls.fhirUser, [AUD + '/Patient/abc123-pat-1']);
}

for (const launch of [undefined, launchToken({ patient: 'pat-1' })]) {
  const flow = launch ? 'EHR launch' : 'standalone';
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid fhirUser launch' });
  Object.defineProperty(s.session, 'defaultLaunchContexts', { get: () => { throw new Error('boom'); } });
  const r = requestDetails({ launch });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check(`${flow}: reading the contexts throws keeps today's behaviour and does not throw`,
    [error, s.calls.fhirUser, r.calls.claims, s.calls.launchResourceIds],
    [null, [], launch ? [['patient', 'pat-1']] : [], launch ? [['patient', 'pat-1']] : []]);
  checkLog(`${flow}: a failed sbx-fhiruser read is logged as a warning`, loaded.logs, 'Sandbox fhirUser context skipped', true);
}

{
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid fhirUser' });
  const bad = { contextType: 'sbx-fhiruser' };
  Object.defineProperty(bad, 'resourceId', { get: () => { throw new Error('boom'); } });
  s.session.defaultLaunchContexts = javaList([bad]);
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, requestDetails({}).details); } catch (e) { error = String(e); }
  check('a resource id accessor that throws sets nothing and does not throw', [error, s.calls.fhirUser], [null, []]);
}

{
  const loaded = load();
  loaded.context.Log.warn = () => { throw new Error('log down'); };
  const s = userSession({ approvedScopes: 'openid fhirUser' });
  Object.defineProperty(s.session, 'defaultLaunchContexts', { get: () => { throw new Error('boom'); } });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, requestDetails({}).details); } catch (e) { error = String(e); }
  check('a failed sbx-fhiruser read survives a Log.warn that throws', [error, s.calls.fhirUser], [null, []]);
}

// A user with no sbx-fhiruser context (every non-sandbox user) gets exactly the
// fhirUser that main's script sets. mainFhirUser is main's rule, copied: the
// launch's practitioner key, else the "practitioner" default context.
function mainFhirUser(contexts, launchObj) {
  if (launchObj && launchObj.practitioner) {
    return [AUD + '/Practitioner/' + launchObj.practitioner];
  }
  const ctx = contexts.find((c) => c.contextType === 'practitioner');
  return ctx && ctx.resourceId ? [AUD + '/' + ctx.resourceId] : [];
}

const noSbxFhirUserContexts = [
  [],
  [practitionerCtx],
  [{ contextType: 'practitioner', resourceId: '' }],
  [{ contextType: 'patient', resourceId: 'pat-a' }],
  [{ contextType: 'patient', resourceId: 'pat-a' }, practitionerCtx, { contextType: 'sbx-patient-2', resourceId: 'pat-b' }],
  [{ contextType: 'patient', resourceId: 'Patient/pat-a' }, { contextType: 'sbx-patient-2', resourceId: 'Patient/pat-b' }],
];
const launchValues = [undefined, { patient: 'pat-1' }, { patient: 'pat-1', practitioner: 'smith-jane' }];
let unchanged = 0;
let combos = 0;
for (const contexts of noSbxFhirUserContexts) {
  for (const launchObj of launchValues) {
    combos++;
    t = token({ approvedScopes: 'openid fhirUser launch launch/patient', contexts },
      launchObj ? { launch: launchToken(launchObj) } : {});
    if (t.error === null && JSON.stringify(t.fhirUser) === JSON.stringify(mainFhirUser(contexts, launchObj))) {
      unchanged++;
    } else {
      console.log(`         differs: contexts ${JSON.stringify(contexts)}, launch ${JSON.stringify(launchObj)}: ${JSON.stringify(t.fhirUser)}`);
    }
  }
}
check(`a user with no sbx-fhiruser gets main's fhirUser (${combos} context and launch combinations)`,
  unchanged, combos);

// ---------------------------------------------------------------------------
// onSmartLoginPreContextSelection: the sandbox patient picker
// ---------------------------------------------------------------------------

console.log('--- picker ---');

// Smile CDR stores one default launch context per type per user, so a sandbox
// writes its default patient as "patient" and the others as sbx-patient-<n>.
// Listed out of number order on purpose: the picker orders by <n>.
const patientCtxs = [
  { contextType: 'sbx-patient-3', resourceId: 'pat-c' },
  { contextType: 'patient', resourceId: 'pat-a' },
  practitionerCtx,
  { contextType: 'sbx-patient-2', resourceId: 'pat-b' },
];

function pickerSession(opts) {
  return userSession(Object.assign({
    clientId: 'sbx-abc123-public',
    approvedScopes: 'openid fhirUser launch/patient patient/*.read',
    contexts: patientCtxs,
  }, opts)).session;
}

let p = pick(pickerSession({}));
check('sbx client standalone with patient, sbx-patient-2 and sbx-patient-3 adds three persons',
  p.persons.length, 3);
check('persons are patient first, then sbx-patient-<n> by number, with the exact ids',
  p.persons.map((x) => x.associatedPatientContextResourceId), ['pat-a', 'pat-b', 'pat-c']);
check('each person is named Patient <resource id>',
  p.persons.map((x) => [x.givenName, x.familyName]),
  [['Patient', 'pat-a'], ['Patient', 'pat-b'], ['Patient', 'pat-c']]);
check('the picker makes no authority or scope calls', p.other, []);
check('the picker does not throw', p.error, null);

p = pick(pickerSession({ clientId: 'inferno-standalone' }));
check('a non-sbx client adds nothing', [p.persons.length, p.other], [0, []]);

p = pick(pickerSession({ clientId: 'my-sbx-client' }));
check('a client that only contains sbx- adds nothing', p.persons.length, 0);

p = pick(pickerSession({ clientId: undefined }));
check('a session with no client id adds nothing', p.persons.length, 0);

p = pick(pickerSession({ approvedScopes: 'openid fhirUser launch launch/patient patient/*.read' }));
check('sbx client EHR launch (scope launch) adds nothing', p.persons.length, 0);

p = pick(pickerSession({ approvedScopes: 'openid fhirUser launch patient/*.read' }));
check('sbx client EHR launch without launch/patient adds nothing', p.persons.length, 0);

p = pick(pickerSession({ approvedScopes: 'openid fhirUser patient/*.read' }));
check('sbx client standalone without launch/patient adds nothing', p.persons.length, 0);

p = pick(pickerSession({ contexts: [{ contextType: 'patient', resourceId: 'pat-a' }, practitionerCtx] }));
check('fewer than two patient contexts adds nothing', p.persons.length, 0);

p = pick(pickerSession({ contexts: [{ contextType: 'sbx-patient-2', resourceId: 'pat-b' }, practitionerCtx] }));
check('a single sbx-patient-<n> context and no patient context adds nothing', p.persons.length, 0);

p = pick(pickerSession({ contexts: [
  { contextType: 'sbx-patient-2', resourceId: 'pat-b' },
  { contextType: 'sbx-patient-3', resourceId: 'pat-c' },
] }));
check('sbx-patient-<n> contexts without a patient context are still offered, by number',
  p.persons.map((x) => x.associatedPatientContextResourceId), ['pat-b', 'pat-c']);

p = pick(pickerSession({ contexts: [
  { contextType: 'patient', resourceId: 'pat-a' },
  { contextType: 'patient', resourceId: 'pat-b' },
  { contextType: 'patient', resourceId: 'pat-c' },
] }));
check('several contexts of type patient alone offer only the first, so nothing is added',
  p.persons.length, 0);

p = pick(pickerSession({ contexts: [
  { contextType: 'patient', resourceId: 'pat-a' },
  { contextType: 'patient', resourceId: 'pat-x' },
  { contextType: 'sbx-patient-2', resourceId: 'pat-b' },
] }));
check('only the first context of type patient is offered',
  p.persons.map((x) => x.associatedPatientContextResourceId), ['pat-a', 'pat-b']);

p = pick(pickerSession({ contexts: [
  { contextType: 'patient', resourceId: 'pat-a' },
  { contextType: 'sbx-patient-2', resourceId: 'pat-a' },
  { contextType: 'sbx-patient-3', resourceId: 'pat-b' },
  { contextType: 'sbx-patient-4', resourceId: 'pat-b' },
] }));
check('a resource id already offered is offered once',
  p.persons.map((x) => x.associatedPatientContextResourceId), ['pat-a', 'pat-b']);

p = pick(pickerSession({ contexts: [
  { contextType: 'patient', resourceId: 'pat-a' },
  { contextType: 'sbx-patient-2', resourceId: '' },
  { contextType: 'sbx-patient-3', resourceId: null },
] }));
check('empty sbx-patient-<n> resource ids are skipped', p.persons.length, 0);

p = pick(pickerSession({ contexts: [
  { contextType: 'patient', resourceId: 'pat-a' },
  { contextType: 'sbx-encounter-2', resourceId: 'enc-1' },
  { contextType: 'sbx-patient', resourceId: 'pat-x' },
  { contextType: 'sbx-patient-two', resourceId: 'pat-y' },
  { contextType: 'my-sbx-patient-2', resourceId: 'pat-z' },
  { contextType: 'sbx-patient-2-old', resourceId: 'pat-w' },
] }));
check('unrelated custom context types are ignored', p.persons.length, 0);

p = pick(pickerSession({ contexts: [
  { contextType: 'Patient', resourceId: 'pat-a' },
  { contextType: 'SBX-Patient-10', resourceId: 'pat-j' },
  { contextType: 'sbx-patient-9', resourceId: 'pat-i' },
] }));
check('context types match case-insensitively and order numerically (9 before 10)',
  p.persons.map((x) => x.associatedPatientContextResourceId), ['pat-a', 'pat-i', 'pat-j']);

{
  const session = pickerSession({});
  session.defaultLaunchContexts = javaList([
    { getContextType: () => 'patient', getResourceId: () => 'pat-a' },
    { getContextType: () => 'sbx-patient-2', getResourceId: () => 'pat-b' },
  ]);
  p = pick(session);
  check('context type and resource id are read through their getters',
    p.persons.map((x) => x.associatedPatientContextResourceId), ['pat-a', 'pat-b']);
}

p = pick(pickerSession({ contexts: [] }));
check('no default launch contexts adds nothing', p.persons.length, 0);

p = pick(pickerSession({ approvedScopes: undefined }));
check('approved scopes unreadable adds nothing', [p.persons.length, p.error], [0, null]);

p = pick(pickerSession({ approvedScopes: '' }));
check('an empty approved scope set adds nothing', p.persons.length, 0);

{
  const session = pickerSession({});
  Object.defineProperty(session, 'defaultLaunchContexts', { get: () => { throw new Error('boom'); } });
  p = pick(session);
  check('an exception reading defaultLaunchContexts is caught', p.error, null);
  check('an exception reading defaultLaunchContexts adds nothing', p.persons.length, 0);
  checkLog('an exception inside the picker is logged as a warning', p.logs, 'Sandbox patient picker skipped', true);
}

{
  const session = pickerSession({});
  Object.defineProperty(session, 'oidcClientId', { get: () => { throw new Error('boom'); } });
  p = pick(session);
  check('an exception reading oidcClientId is caught and adds nothing', [p.error, p.persons.length], [null, 0]);
}

{
  const session = pickerSession({});
  const bad = { contextType: 'sbx-patient-4' };
  Object.defineProperty(bad, 'resourceId', { get: () => { throw new Error('boom'); } });
  session.defaultLaunchContexts = javaList([patientCtxs[0], patientCtxs[1], patientCtxs[3], bad]);
  p = pick(session);
  check('an exception on the last context adds no person at all', [p.error, p.persons.length], [null, 0]);
}

// A failure while adding: Smile CDR has no call to take a person back, so the
// patient id is written before the names and no complete-looking person can
// lack it. Each case lists exactly what is left behind.

/** Choices whose addPerson builds each person with makePerson(n). */
function failingChoices(makePerson) {
  const persons = [];
  let n = 0;
  return {
    persons,
    choices: {
      addPerson: () => {
        const person = makePerson(n++);
        persons.push(person);
        return person;
      },
    },
  };
}

function pickWith(makePerson) {
  const loaded = load();
  const c = failingChoices(makePerson);
  let error = null;
  try {
    loaded.context.onSmartLoginPreContextSelection(pickerSession({}), c.choices);
  } catch (e) {
    error = String(e);
  }
  return { error, persons: c.persons, logs: loaded.logs };
}

function throwingOn(property) {
  const person = {};
  Object.defineProperty(person, property, {
    set: () => { throw new Error('no such property ' + property); },
    enumerable: true,
  });
  return person;
}

p = pickWith((n) => { if (n === 1) { throw new Error('boom'); } return {}; });
check('addPerson throwing on the second person leaves only the first, complete',
  [p.error, p.persons], [null, [{ associatedPatientContextResourceId: 'pat-a', givenName: 'Patient', familyName: 'pat-a' }]]);
checkLog('addPerson throwing is logged as a warning', p.logs, 'Sandbox patient picker skipped', true);

for (const property of ['givenName', 'familyName']) {
  p = pickWith(() => throwingOn(property));
  check(`a ${property} write that throws leaves no person without a patient id`,
    [p.error, p.persons.length, p.persons.every((x) => x.associatedPatientContextResourceId === 'pat-a')],
    [null, 1, true]);
}

p = pickWith((n) => (n === 1 ? throwingOn('givenName') : {}));
check('a name write throwing on the second person leaves two persons, each with its patient id',
  [p.error, p.persons.map((x) => x.associatedPatientContextResourceId)], [null, ['pat-a', 'pat-b']]);

p = pickWith((n) => (n === 1 ? throwingOn('associatedPatientContextResourceId') : {}));
check('a patient id write throwing on the second person leaves the first complete and the second empty',
  [p.error, p.persons.length, p.persons[0].associatedPatientContextResourceId,
    Object.keys(p.persons[1]).filter((k) => p.persons[1][k] !== undefined)],
  [null, 2, 'pat-a', []]);

{
  const loaded = load();
  let error = null;
  try {
    loaded.context.onSmartLoginPreContextSelection(null, contextChoices().choices);
  } catch (e) {
    error = String(e);
  }
  check('a null user session adds nothing and does not throw', error, null);
}

{
  const context = {
    Converter: { base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8') },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: SCRIPT });
  const session = pickerSession({});
  Object.defineProperty(session, 'defaultLaunchContexts', { get: () => { throw new Error('boom'); } });
  let error = null;
  try {
    context.onSmartLoginPreContextSelection(session, contextChoices().choices);
  } catch (e) {
    error = String(e);
  }
  check('the picker survives an error with no Log global', error, null);
}

{
  const session = pickerSession({});
  session.defaultLaunchContexts = patientCtxs;
  p = pick(session);
  check('default launch contexts given as a JS array are read', p.persons.length, 3);
}

// ---------------------------------------------------------------------------
// Java-shaped objects, as Smile CDR's GraalJS engine hands them
// ---------------------------------------------------------------------------

console.log('--- Java-shaped session and request (GraalJS) ---');

/**
 * A UserSessionDetailsJson as the script sees it on GraalJS: getters only, no
 * bean properties. `approved` is a space-separated scope string turned into a
 * strict Java set, 'throws' for a getApprovedScopes() that throws, or
 * undefined for no getter at all. `misses` collects any non-Java member read.
 */
function javaShapedSession(opts) {
  const o = opts || {};
  const misses = [];
  const calls = { launchResourceIds: [], fhirUser: [] };
  const contexts = o.contexts || [];
  const session = {
    getOidcClientId: () => (o.clientId === undefined ? null : o.clientId),
    getDefaultLaunchContexts: () => javaList(contexts),
    addLaunchResourceId: (k, v) => calls.launchResourceIds.push([k, v]),
    setFhirUserUrl: (u) => calls.fhirUser.push(u),
    getOrCreateDefaultLaunchContext: (type) =>
      contexts.find((c) => c.contextType === type) || { contextType: type, resourceId: null },
  };
  if (o.approved === 'throws') {
    session.getApprovedScopes = () => { throw new Error('IllegalStateException: no approved scopes'); };
  } else if (o.approved !== undefined) {
    session.getApprovedScopes = () => strictJavaSet(o.approved.split(' ').filter(Boolean), misses);
  }
  return { session, calls, misses };
}

/** onTokenGenerating with a Java-shaped session and a Java-shaped request map. */
function javaToken(sessionOpts, requestOpts) {
  const loaded = load();
  const s = javaShapedSession(sessionOpts);
  const r = requestDetails(Object.assign({ javaMaps: true, misses: s.misses }, requestOpts));
  let error = null;
  try {
    loaded.context.onTokenGenerating(s.session, r.details);
  } catch (e) {
    error = String(e);
  }
  return {
    error,
    claims: r.calls.claims,
    launchResourceIds: s.calls.launchResourceIds,
    fhirUser: s.calls.fhirUser,
    misses: s.misses,
    logs: loaded.logs,
  };
}

/** The "Sandbox scopes" diagnostic lines in a run's logs. */
function sandboxLines(logs) {
  return logs.filter(([, m]) => String(m).indexOf('Sandbox scopes at ') === 0).map(([level, m]) => [level, String(m)]);
}

const ehrScopes = 'openid fhirUser launch launch/patient patient/*.read';
const pat1 = launchToken({ patient: 'pat-1' });

for (const clientId of ['sbx-abc123-public', 'inferno-ehr']) {
  t = javaToken({ clientId, approved: ehrScopes, contexts: [practitionerCtx] },
    { launch: pat1, params: { scope: ehrScopes }, smileHolds: ['patient'] });
  check(`${clientId}: EHR launch "launch launch/patient" with Java objects adds no duplicate claim (was HTTP 500)`,
    [t.error, t.claims, t.launchResourceIds, t.fhirUser],
    [null, [], [['patient', 'pat-1']], [AUD + '/Practitioner/guthridge-jarred']]);
  check(`${clientId}: the scopes are read only through Java methods`, t.misses, []);
}

t = javaToken({ approved: 'throws' }, { launch: pat1, params: {}, smileHolds: ['patient'] });
check('the mock reproduces the 500: a duplicate patient claim throws IllegalArgumentException',
  /IllegalArgumentException/.test(String(t.error)), true);

t = javaToken({ approved: 'openid fhirUser launch patient/*.read' },
  { launch: pat1, params: { scope: 'openid fhirUser launch patient/*.read' } });
check('Java objects: EHR launch with "launch" alone adds the patient claim',
  [t.error, t.claims, t.launchResourceIds], [null, [['patient', 'pat-1']], [['patient', 'pat-1']]]);

t = javaToken({ approved: '' }, { launch: pat1, params: { scope: 'launch launch/patient' }, smileHolds: ['patient'] });
check('Java objects: an empty approved set (size 0) is unknown, and a request with launch/patient skips the claim',
  [t.error, t.claims], [null, []]);

t = javaToken({ approved: '' }, { launch: pat1, params: { scope: 'openid launch' } });
check('Java objects: an empty approved set and a request without launch/patient adds the claim',
  t.claims, [['patient', 'pat-1']]);

t = javaToken({ approved: 'throws' }, { launch: pat1, params: { scope: 'openid launch launch/patient' }, smileHolds: ['patient'] });
check('getApprovedScopes() throwing and no approvedScopes falls back to the request: launch/patient skips the claim',
  [t.error, t.claims], [null, []]);

t = javaToken({ approved: 'throws' }, { launch: pat1, params: { scope: 'openid launch' } });
check('getApprovedScopes() throwing and no approvedScopes falls back to the request: launch alone adds the claim',
  t.claims, [['patient', 'pat-1']]);

t = javaToken({}, { launch: pat1, params: { scope: 'launch launch/patient' }, smileHolds: ['patient'] });
check('no getApprovedScopes() and no approvedScopes falls back to the request', [t.error, t.claims], [null, []]);

t = javaToken({ approved: 'throws' }, { launch: pat1, params: {} });
check('approved scopes unknown and no scope parameter adds the claim (today\'s behaviour)',
  [t.error, t.claims], [null, [['patient', 'pat-1']]]);

{
  const loaded = load();
  const s = javaShapedSession({ approved: 'throws' });
  const r = requestDetails({ launch: pat1 });
  r.details.getRequestParameters = () => { throw new Error('no request parameters'); };
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('approved scopes unknown and getRequestParameters() throwing adds the claim',
    [error, r.calls.claims], [null, [['patient', 'pat-1']]]);
}

t = javaToken({ approved: 'openid launch launch/patient' }, { launch: pat1, params: { scope: 'openid launch' } });
check('Java objects: a remembered launch/patient approval this request did not ask for adds the claim',
  t.claims, [['patient', 'pat-1']]);

t = javaToken({ approved: 'openid launch' }, { launch: pat1, params: { scope: 'openid launch launch/patient' } });
check('Java objects: launch/patient requested but not granted adds the claim', t.claims, [['patient', 'pat-1']]);

t = javaToken({ approved: 'openid launch launch/patient launch/encounter' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }), params: { scope: 'openid launch launch/encounter' },
    smileHolds: ['encounter'] });
check('Java objects: each key is decided on its own', [t.error, t.claims], [null, [['patient', 'pat-1']]]);

for (const answer of [undefined, null, 'true', 1]) {
  const loaded = load();
  const s = javaShapedSession({});
  s.session.getApprovedScopes = () => ({ contains: () => answer, size: () => 3 });
  const r = requestDetails({ launch: pat1, params: { scope: 'openid launch' } });
  loaded.context.onTokenGenerating(s.session, r.details);
  check(`contains() answering ${JSON.stringify(answer)} (not a boolean) is unknown, and the request decides`,
    r.calls.claims, [['patient', 'pat-1']]);
}

{
  // getApprovedScopes() fails but the field form works: the second read decides.
  const loaded = load();
  const s = javaShapedSession({ approved: 'throws' });
  s.session.approvedScopes = strictJavaSet(['openid', 'launch']);
  const r = requestDetails({ launch: pat1, params: { scope: 'openid launch launch/patient' } });
  loaded.context.onTokenGenerating(s.session, r.details);
  check('the approvedScopes field is tried when getApprovedScopes() throws', r.calls.claims, [['patient', 'pat-1']]);
}

console.log('--- Java-shaped: sandbox diagnostic log ---');

t = javaToken({ clientId: 'sbx-abc123-public', approved: ehrScopes }, { launch: pat1, params: { scope: ehrScopes } });
check('sbx EHR launch logs one diagnostic line at token generation, at info',
  sandboxLines(t.logs).map(([level, m]) => [level, m.split(':')[0]]), [['info', 'Sandbox scopes at token generation']]);
check('the token line names the read, the set\'s size() and toString(), and the requested scope string',
  sandboxLines(t.logs).map(([, m]) => m),
  ['Sandbox scopes at token generation: approved read=getApprovedScopes() size=5 ' +
    'scopes=[openid, fhirUser, launch, launch/patient, patient/*.read]; requested=' + ehrScopes + '; EHR launch']);
check('the token line carries no launch value', sandboxLines(t.logs).some(([, m]) => m.includes('pat-1') || m.includes(pat1)), false);

t = javaToken({ clientId: 'sbx-abc123-public', approved: 'throws' }, { launch: pat1, params: {} });
check('an unreadable approved set is logged with why each read failed, and an absent request as null',
  sandboxLines(t.logs).map(([, m]) => /^Sandbox scopes at token generation: approved read=none \(getApprovedScopes\(\) threw .*IllegalStateException.*; approvedScopes threw .*\); requested=null; EHR launch$/.test(m)),
  [true]);

t = javaToken({ clientId: 'sbx-abc123-public', approved: 'openid fhirUser launch/patient' }, {});
check('sbx standalone token generation logs a line too',
  sandboxLines(t.logs).map(([, m]) => m.endsWith('; standalone launch')), [true]);

{
  const loaded = load();
  const s = javaShapedSession({ clientId: 'sbx-abc123-public', approved: ehrScopes });
  loaded.context.Log.info = (m) => {
    if (String(m).indexOf('Sandbox scopes at ') === 0) {
      throw new Error('log down');
    }
  };
  const r = requestDetails({ javaMaps: true, launch: pat1, params: { scope: ehrScopes }, smileHolds: ['patient'] });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('a diagnostic Log.info that throws does not fail token generation',
    [error, r.calls.claims, s.calls.launchResourceIds], [null, [], [['patient', 'pat-1']]]);
}

console.log('--- Java-shaped: sandbox patient chooser ---');

function javaPick(opts) {
  const s = javaShapedSession(Object.assign({ clientId: 'sbx-abc123-public', contexts: patientCtxs }, opts));
  const result = pick(s.session);
  result.misses = s.misses;
  return result;
}

p = javaPick({ approved: 'openid fhirUser launch/patient patient/*.read' });
check('Java objects: sbx standalone launch offers the chooser',
  [p.error, p.persons.map((x) => x.associatedPatientContextResourceId), p.misses], [null, ['pat-a', 'pat-b', 'pat-c'], []]);
check('Java objects: the chooser logs one line with the choice count',
  sandboxLines(p.logs).map(([, m]) => m),
  ['Sandbox scopes at context selection: approved read=getApprovedScopes() size=4 ' +
    'scopes=[openid, fhirUser, launch/patient, patient/*.read]; requested=(not available here); ' +
    'standalone launch, 3 patient choices']);

p = javaPick({ approved: 'openid fhirUser launch launch/patient patient/*.read' });
check('Java objects: sbx EHR launch offers no chooser', [p.error, p.persons.length, p.other], [null, 0, []]);
check('Java objects: sbx EHR launch logs that no chooser was offered',
  sandboxLines(p.logs).map(([, m]) => m.endsWith('; chooser not offered')), [true]);

p = javaPick({ approved: 'throws' });
check('Java objects: approved scopes unknown offers no chooser', [p.error, p.persons.length], [null, 0]);

p = javaPick({ approved: '' });
check('Java objects: an empty approved set offers no chooser', [p.error, p.persons.length], [null, 0]);

p = javaPick({ approved: 'openid fhirUser launch/patient', contexts: [{ contextType: 'patient', resourceId: 'pat-a' }] });
check('Java objects: one patient choice offers no chooser but still logs the count',
  [p.persons.length, sandboxLines(p.logs).map(([, m]) => m.endsWith('; standalone launch, 1 patient choices'))], [0, [true]]);

console.log('--- Java-shaped: non-sandbox logins against the previous rule ---');

/**
 * The claim rule of the previous script (#132), copied, on scope lists: an
 * empty or unreadable approved list is unknown, as is an empty request.
 */
function previousSkips(key, approved, requested) {
  const scope = 'launch/' + key;
  const a = approved && approved.length ? approved : null;
  const r = requested && requested.length ? requested : null;
  if (a) {
    return a.includes(scope) && (!r || r.includes(scope));
  }
  if (r) {
    return r.includes(scope);
  }
  return false;
}

const approvedVariants = ['throws', '', 'openid launch', 'openid launch launch/patient',
  'launch launch/patient launch/encounter', 'launch/patient', 'openid fhirUser launch/patient patient/*.read'];
const requestedVariants = [null, '', 'launch', 'openid launch launch/patient', 'openid launch launch/encounter',
  'launch/patient openid'];
const launchVariants = [undefined, { patient: 'pat-1' }, { patient: 'pat-1', encounter: 'enc-1' },
  { patient: 'pat-1', practitioner: 'smith-jane' }];
const nonSandboxClients = ['inferno-ehr', undefined, 'my-sbx-client', 'SBX-upper'];
let same = 0;
let total = 0;
for (const clientId of nonSandboxClients) {
  for (const approved of approvedVariants) {
    for (const requested of requestedVariants) {
      for (const launchObj of launchVariants) {
        total++;
        const params = requested === null ? {} : { scope: requested };
        t = javaToken({ clientId, approved, contexts: [practitionerCtx] },
          Object.assign({ params }, launchObj ? { launch: launchToken(launchObj) } : {}));
        const approvedList = approved === 'throws' ? null : approved.split(' ').filter(Boolean);
        const requestedList = requested === null ? null : requested.split(/\s+/).filter(Boolean);
        const keys = launchObj ? Object.keys(launchObj).filter((k) => k !== 'practitioner') : [];
        const expected = {
          error: null,
          claims: keys.filter((k) => !previousSkips(k, approvedList, requestedList)).map((k) => [k, launchObj[k]]),
          launchResourceIds: keys.map((k) => [k, launchObj[k]]),
          fhirUser: mainFhirUser([practitionerCtx], launchObj),
          lines: [],
        };
        const actual = {
          error: t.error,
          claims: t.claims,
          launchResourceIds: t.launchResourceIds,
          fhirUser: t.fhirUser,
          lines: sandboxLines(t.logs),
        };
        if (JSON.stringify(actual) === JSON.stringify(expected)) {
          same++;
        } else {
          console.log(`         differs: client ${clientId}, approved ${JSON.stringify(approved)}, requested ${JSON.stringify(requested)}, ` +
            `launch ${JSON.stringify(launchObj)}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
        }
      }
    }
  }
}
check(`non-sandbox token generation matches the previous rule with no log line (${total} combinations)`, same, total);

let pickSame = 0;
let pickTotal = 0;
for (const clientId of nonSandboxClients) {
  for (const approved of approvedVariants) {
    pickTotal++;
    p = javaPick({ clientId, approved });
    if (p.error === null && p.persons.length === 0 && p.other.length === 0 && p.logs.length === 0) {
      pickSame++;
    }
  }
}
check(`non-sandbox context selection adds nothing and logs nothing (${pickTotal} combinations)`, pickSame, pickTotal);

console.log(`\n${passes}/${passes + failures} checks passed`);
process.exit(failures > 0 ? 1 : 0);
