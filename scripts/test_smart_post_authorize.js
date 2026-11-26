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
 * covered exactly, but the accessor names (approvedScopes, oidcClientId,
 * defaultLaunchContexts) and whether approvedScopes is populated at context
 * selection and at token generation come from the Smile CDR documentation, not
 * from a measurement. The mocks below encode what the script is willing to
 * accept, not what the deployed build offers. The live check after a sync is
 * what settles that.
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

/** Mock java.util.Set<String>: contains, size and an iterator, nothing else. */
function javaSet(items) {
  return {
    contains: (x) => items.includes(x),
    size: () => items.length,
    iterator: () => {
      let i = 0;
      return { hasNext: () => i < items.length, next: () => items[i++] };
    },
  };
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
  const details = {
    getAudience: () => (o.audience === undefined ? AUD : o.audience),
    getLaunch: () => o.launch || null,
    getRequestParameters: () => ({ get: (k) => (k in params ? params[k] : null) }),
    addAccessTokenClaim: (k, v) => {
      // Smile CDR refuses a claim it already holds (validateDontAlreadyHaveClaim).
      if (calls.claims.some(([key]) => key === k)) {
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
  const loaded = load();
  const s = userSession({});
  s.session.approvedScopes = ['openid', 'launch', 'launch/patient'];
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  loaded.context.onTokenGenerating(s.session, r.details);
  check('approved scopes given as a JS array are read', r.calls.claims, []);
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

console.log(`\n${passes}/${passes + failures} checks passed`);
process.exit(failures > 0 ? 1 : 0);
