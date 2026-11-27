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
 * is not reproduced. The engine-shape mocks (shapedSession) add what a host
 * access policy that exposes only the documented callback methods may leave:
 * an approved set that answers only toString() or only for-of, and a context
 * list that exposes nothing, with getOrCreateDefaultLaunchContext(type)
 * working (measured on aucore). Which shape the deployed build is, is not
 * known; the live check after the pod rolls, with the sandbox diagnostic log
 * line naming the read that worked, is what settles that.
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
  const calls = { launchResourceIds: [], fhirUser: [], removedScopes: [] };
  const contexts = o.contexts || [];
  const approved = o.approvedScopes === undefined ? null : o.approvedScopes.split(' ').filter(Boolean);
  calls.approved = approved;
  const session = {
    oidcClientId: o.clientId,
    defaultLaunchContexts: javaList(contexts),
    addLaunchResourceId: (k, v) => calls.launchResourceIds.push([k, v]),
    setFhirUserUrl: (u) => calls.fhirUser.push(u),
    getOrCreateDefaultLaunchContext: (type) =>
      contexts.find((c) => c.contextType === type) || { contextType: type, resourceId: null },
    // UserSessionDetails.removeApprovedScope: edits the session's approved
    // set in place (measured on Smile CDR 2026.05.R01 and 2026.11.R01: the set
    // read before the call answers without the scope afterwards).
    removeApprovedScope: (scope) => {
      calls.removedScopes.push(scope);
      if (approved) {
        const i = approved.indexOf(scope);
        if (i >= 0) {
          approved.splice(i, 1);
        }
      }
    },
  };
  if (approved) {
    session.approvedScopes = javaSet(approved);
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
    getRequestParameters: () => (o.javaMaps ? strictJavaMap(params, o.misses) : { get: (k) => (k in params ? params[k] : null) }),
    addAccessTokenClaim: (k, v) => {
      // A second claim of the same key from the script itself is refused. Smile
      // CDR's own launch claims are modelled separately (smileAddLaunchScopes):
      // the script's claim does not count towards Smile's check (measured).
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
    removedScopes: s ? s.calls.removedScopes : [],
    approvedAfter: s && s.calls.approved ? s.calls.approved.slice() : null,
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
check('EHR launch with "launch launch/patient" drops launch/patient from the approved scopes',
  [t.removedScopes, t.approvedAfter], [['launch/patient'], ['openid', 'fhirUser', 'launch', 'patient/*.read']]);
check('EHR launch with "launch launch/patient" adds the patient claim, as with "launch" alone',
  t.claims, [['patient', 'pat-1']]);
check('EHR launch with "launch launch/patient" does not throw', t.error, null);

t = token({ approvedScopes: 'openid launch launch/patient launch/encounter' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }) });
check('EHR launch with launch/encounter adds both launch resource ids',
  t.launchResourceIds, [['patient', 'pat-1'], ['encounter', 'enc-1']]);
check('EHR launch with launch/patient and launch/encounter drops both and adds both claims',
  [t.removedScopes, t.claims], [['launch/patient', 'launch/encounter'], [['patient', 'pat-1'], ['encounter', 'enc-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }) });
check('EHR launch without launch/encounter drops launch/patient only and adds both claims',
  [t.removedScopes, t.claims], [['launch/patient'], [['patient', 'pat-1'], ['encounter', 'enc-1']]]);
check('EHR launch without launch/encounter adds both launch resource ids',
  t.launchResourceIds, [['patient', 'pat-1'], ['encounter', 'enc-1']]);

t = token({ approvedScopes: 'openid launch launch/encounter' },
  { launch: launchToken({ encounter: 'enc-1' }) });
check('EHR launch with "launch launch/encounter" drops launch/encounter and adds the encounter claim',
  [t.removedScopes, t.claims, t.launchResourceIds], [['launch/encounter'], [['encounter', 'enc-1']], [['encounter', 'enc-1']]]);

t = token({ approvedScopes: 'openid launch' },
  { launch: launchToken({ encounter: 'enc-1' }) });
check('EHR launch with "launch" adds the encounter claim (today\'s behaviour)',
  [t.claims, t.launchResourceIds], [[['encounter', 'enc-1']], [['encounter', 'enc-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { launch: launchToken({ patient: 'pat-1', practitioner: 'smith-jane' }) });
check('a practitioner in the launch token sets fhirUser',
  t.fhirUser, [AUD + '/Practitioner/smith-jane']);
check('a practitioner in the launch token is never a claim or launch resource id',
  [t.claims, t.launchResourceIds], [[['patient', 'pat-1']], [['patient', 'pat-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient' },
  { params: { launch: launchToken({ patient: 'pat-1' }) } });
check('a launch token from the whitelisted request parameter follows the same rule',
  [t.removedScopes, t.claims, t.launchResourceIds], [['launch/patient'], [['patient', 'pat-1']], [['patient', 'pat-1']]]);

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
  check('approved scopes are read through getApprovedScopes() when the property is absent (launch/patient dropped and claimed)',
    [s.calls.removedScopes, r.calls.claims], [['launch/patient'], [['patient', 'pat-1']]]);
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
  check('approved scopes given as a Java set field (no getter) are read (launch/patient dropped and claimed)',
    [s.calls.removedScopes, r.calls.claims], [['launch/patient'], [['patient', 'pat-1']]]);
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
check('launch launch/patient both approved and requested: launch/patient dropped, claim added',
  [t.error, t.removedScopes, t.claims, t.launchResourceIds], [null, ['launch/patient'], [['patient', 'pat-1']], [['patient', 'pat-1']]]);

{
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid launch launch/patient' });
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  r.details.getRequestParameters = () => { throw new Error('no request parameters'); };
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('request parameters unreadable and launch launch/patient approved: dropped, claim added',
    [error, s.calls.removedScopes, r.calls.claims, s.calls.launchResourceIds], [null, ['launch/patient'], [['patient', 'pat-1']], [['patient', 'pat-1']]]);
}

t = token({}, { launch: launchToken({ patient: 'pat-1' }), params: {} });
check('neither approved scopes nor the scope parameter readable adds the claim',
  [t.error, t.claims], [null, [['patient', 'pat-1']]]);

t = token({ approvedScopes: 'openid launch launch/patient launch/encounter' },
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }), params: { scope: 'openid launch launch/encounter' } });
check('with "launch" approved every approved launch/<key> is dropped, remembered or not, and each claim added',
  [t.removedScopes, t.claims], [['launch/patient', 'launch/encounter'], [['patient', 'pat-1'], ['encounter', 'enc-1']]]);

// ---------------------------------------------------------------------------
// onTokenGenerating: against Smile CDR's own launch claims (measured)
// ---------------------------------------------------------------------------

console.log('--- token: Smile CDR launch claims, as measured on 2026.05.R01 and 2026.11.R01 ---');

/**
 * What SmartTokenEnhancerSvcImpl.addLaunchScopes does with the session the
 * script leaves behind, measured on local Smile CDR 2026.05.R01 and 2026.11.R01
 * (27 Nov 2026), with a script that only calls addLaunchResourceId and with
 * this script: for each launch resource id of type <key>, Smile adds the <key>
 * claim once for each approved scope that covers it ("launch" covers every
 * key, "launch/<key>" its own), and a second add of its own throws
 * IllegalArgumentException (validateDontAlreadyHaveClaim): the token 500. The
 * script's own addAccessTokenClaim does not count towards that check ("launch"
 * alone with the script's claim answers 200). Returns 'ok' or 'HTTP 500'.
 */
function smileAddLaunchScopes(t) {
  const approved = t.approvedAfter || [];
  for (const [key] of t.launchResourceIds) {
    const adds = (approved.includes('launch') ? 1 : 0) + (approved.includes('launch/' + key) ? 1 : 0);
    if (adds > 1) {
      return 'HTTP 500';
    }
  }
  return 'ok';
}

/** Every claim key the token would carry: the script's and Smile CDR's. */
function tokenClaimKeys(t) {
  const approved = t.approvedAfter || [];
  const keys = t.claims.map(([k]) => k);
  for (const [key] of t.launchResourceIds) {
    if ((approved.includes('launch') || approved.includes('launch/' + key)) && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys.sort();
}

/**
 * Run onTokenGenerating with the approved scopes behind a reader that copies
 * them when read (only toString(), as on a host policy that refuses contains()),
 * so the script's view does not change after removeApprovedScope.
 */
function tokenWithSnapshotScopes(scopes, requestOpts) {
  const loaded = load();
  const s = userSession({ approvedScopes: scopes, contexts: [practitionerCtx] });
  const live = s.calls.approved;
  s.session.approvedScopes = undefined;
  s.session.getApprovedScopes = () => ({ toString: () => '[' + live.join(', ') + ']' });
  const r = requestDetails(requestOpts);
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  return { error, claims: r.calls.claims, launchResourceIds: s.calls.launchResourceIds,
    removedScopes: s.calls.removedScopes, approvedAfter: live.slice(), logs: loaded.logs };
}

{
  const launches = [{ patient: 'pat-1' }, { patient: 'pat-1', encounter: 'enc-1' }, { encounter: 'enc-1' },
    { patient: 'pat-1', practitioner: 'smith-jane' }];
  const scopeSets = ['openid launch', 'openid launch launch/patient', 'openid launch launch/encounter',
    'openid launch launch/patient launch/encounter', 'openid launch/patient', 'openid launch/patient launch/encounter',
    'openid launch fhirUser launch/patient patient/*.rs'];
  let cells = 0;
  const bad = [];
  for (const launch of launches) {
    for (const scopes of scopeSets) {
      for (const [requested, reader] of [[undefined, 'live'], [scopes, 'live'], ['openid launch', 'live'],
        [undefined, 'snapshot'], [scopes, 'snapshot']]) {
        const req = { launch: launchToken(launch), params: requested === undefined ? {} : { scope: requested } };
        const tt = reader === 'live' ? token({ approvedScopes: scopes, contexts: [practitionerCtx] }, req)
          : tokenWithSnapshotScopes(scopes, req);
        cells++;
        const expectedKeys = Object.keys(launch).filter((k) => k !== 'practitioner').sort();
        const outcome = [tt.error, smileAddLaunchScopes(tt), tokenClaimKeys(tt)];
        if (JSON.stringify(outcome) !== JSON.stringify([null, 'ok', expectedKeys])) {
          bad.push([launch, scopes, requested === undefined ? 'no scope param' : requested, reader, outcome]);
        }
      }
    }
  }
  check(`no EHR launch cell gets Smile CDR's duplicate claim, and each carries every launch key once (${cells} cells)`,
    bad, []);
}

t = token({ approvedScopes: 'openid launch/patient patient/*.rs' }, { launch: launchToken({ patient: 'pat-1' }) });
check('launch/patient without launch and a launch value: nothing dropped, Smile adds the claim once (measured 200)',
  [t.removedScopes, t.claims, smileAddLaunchScopes(t), tokenClaimKeys(t)], [[], [], 'ok', ['patient']]);

t = token({ approvedScopes: 'openid launch patient/*.rs' }, { launch: launchToken({ patient: 'pat-1' }) });
check('launch alone: nothing dropped, Smile adds the claim once and the script adds its own (measured 200)',
  [t.removedScopes, t.claims, smileAddLaunchScopes(t)], [[], [['patient', 'pat-1']], 'ok']);

t = token({ approvedScopes: 'openid fhirUser launch/patient patient/*.rs', contexts: [practitionerCtx] }, {});
check('a standalone launch drops no scope', [t.removedScopes, t.approvedAfter],
  [[], ['openid', 'fhirUser', 'launch/patient', 'patient/*.rs']]);

{
  // A session whose removeApprovedScope fails: the scope stays, so the claim
  // rule of #132 and #134 decides (skip), a warning is logged, nothing throws.
  const loaded = load();
  const s = userSession({ approvedScopes: 'openid launch launch/patient' });
  s.session.removeApprovedScope = () => { throw new Error('refused'); };
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }) });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('a removeApprovedScope that throws leaves the approved scopes and the old claim rule',
    [error, r.calls.claims], [null, []]);
  checkLog('a removeApprovedScope that throws is logged as a warning', loaded.logs, 'Could not drop the approved scope launch/patient', true);
}

{
  // Unknown approved scopes: never narrowed.
  const tt = token({}, { launch: launchToken({ patient: 'pat-1' }), params: { scope: 'openid launch launch/patient' } });
  check('approved scopes unreadable: nothing is dropped', tt.removedScopes, []);
}

{
  // The Java-shaped twin: only contains/size/iterator/toString on the set.
  const loaded = load();
  const misses = [];
  const items = ['openid', 'launch', 'launch/patient'];
  const s = userSession({});
  s.session.approvedScopes = strictJavaSet(items, misses);
  s.session.removeApprovedScope = (x) => { s.calls.removedScopes.push(x); items.splice(items.indexOf(x), 1); };
  const r = requestDetails({ launch: launchToken({ patient: 'pat-1' }), javaMaps: true, misses });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  checkLog('a dropped scope is logged by name', loaded.logs, 'dropped approved scope launch/patient', true);
  check('a Java-shaped session: launch/patient dropped through removeApprovedScope, claim added, no JS-only member read',
    [error, s.calls.removedScopes, r.calls.claims, misses], [null, ['launch/patient'], [['patient', 'pat-1']], []]);
}

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
// login whose deployment names a Patient as fhirUser. The script reads it only
// for a sandbox client (id starting "sbx-"), so these logins use one.
const SBX_APP = 'sbx-abc123-app';
const sbxPatientFhirUser = { contextType: 'sbx-fhiruser', resourceId: 'Patient/abc123-pat-1' };

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser launch/patient', contexts: [sbxPatientFhirUser] }, {});
check('standalone with sbx-fhiruser Patient/... and no practitioner sets fhirUser to that Patient',
  [t.error, t.fhirUser], [null, [AUD + '/Patient/abc123-pat-1']]);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser', contexts: [sbxPatientFhirUser] },
  { audience: 'https://smile.sparked-fhir.com/aucore/fhir/VENDOR-A/' });
check('the sbx-fhiruser reference is put under the (normalised) audience',
  t.fhirUser, ['https://smile.sparked-fhir.com/aucore/fhir/VENDOR-A/Patient/abc123-pat-1']);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser', contexts: [sbxPatientFhirUser, practitionerCtx] }, {});
check('a practitioner context wins over sbx-fhiruser',
  t.fhirUser, [AUD + '/Practitioner/guthridge-jarred']);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser launch', contexts: [sbxPatientFhirUser] },
  { launch: launchToken({ patient: 'pat-1' }) });
check('EHR launch without a practitioner key falls back to sbx-fhiruser',
  [t.error, t.fhirUser, t.launchResourceIds], [null, [AUD + '/Patient/abc123-pat-1'], [['patient', 'pat-1']]]);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser launch', contexts: [sbxPatientFhirUser] },
  { launch: launchToken({ patient: 'pat-1', practitioner: 'smith-jane' }) });
check('EHR launch with a practitioner key ignores sbx-fhiruser',
  t.fhirUser, [AUD + '/Practitioner/smith-jane']);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser',
  contexts: [{ contextType: 'sbx-fhiruser', resourceId: 'Practitioner/abc123-prac-1' }] }, {});
check('sbx-fhiruser may name a Practitioner',
  t.fhirUser, [AUD + '/Practitioner/abc123-prac-1']);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser',
  contexts: [{ contextType: 'SBX-FhirUser', resourceId: 'Patient/abc123-pat-1' }] }, {});
check('the sbx-fhiruser context type matches case-insensitively',
  t.fhirUser, [AUD + '/Patient/abc123-pat-1']);

for (const type of ['sbx-fhiruser-2', 'fhiruser', 'my-sbx-fhiruser', 'patient']) {
  t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser', contexts: [{ contextType: type, resourceId: 'Patient/abc123-pat-1' }] }, {});
  check(`a context of type ${type} is not sbx-fhiruser and sets nothing`, t.fhirUser, []);
}

for (const resourceId of ['abc123-pat-1', 'Organization/x', 'Patient/a/b', 'Patient/a b', 'patient/abc123-pat-1',
  'Patient/', '', null, 'Patient/' + 'a'.repeat(65), ' Patient/abc123-pat-1', 'Patient/abc123-pat-1\n',
  '../Patient/x', 'Patient/x?_format=json']) {
  t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser', contexts: [{ contextType: 'sbx-fhiruser', resourceId }] }, {});
  check(`a malformed sbx-fhiruser resource id ${JSON.stringify(resourceId)} sets nothing`,
    [t.error, t.fhirUser], [null, []]);
}

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser',
  contexts: [{ contextType: 'sbx-fhiruser', resourceId: 'Patient/' + 'a'.repeat(64) }] }, {});
check('a 64-character id is accepted', t.fhirUser, [AUD + '/Patient/' + 'a'.repeat(64)]);

t = token({ clientId: SBX_APP, approvedScopes: 'openid fhirUser', contexts: [
  { contextType: 'sbx-fhiruser', resourceId: 'Organization/x' },
  { contextType: 'sbx-fhiruser', resourceId: 'Patient/abc123-pat-1' },
] }, {});
check('only the first sbx-fhiruser context counts', t.fhirUser, []);

{
  const loaded = load();
  const s = userSession({ clientId: SBX_APP, approvedScopes: 'openid fhirUser' });
  s.session.defaultLaunchContexts = javaList([
    { getContextType: () => 'sbx-fhiruser', getResourceId: () => 'Patient/abc123-pat-1' },
  ]);
  loaded.context.onTokenGenerating(s.session, requestDetails({}).details);
  check('the sbx-fhiruser context is read through its getters', s.calls.fhirUser, [AUD + '/Patient/abc123-pat-1']);
}

{
  const loaded = load();
  const s = userSession({ clientId: SBX_APP, approvedScopes: 'openid fhirUser' });
  s.session.defaultLaunchContexts = [sbxPatientFhirUser];
  loaded.context.onTokenGenerating(s.session, requestDetails({}).details);
  check('default launch contexts given as a JS array are read for sbx-fhiruser',
    s.calls.fhirUser, [AUD + '/Patient/abc123-pat-1']);
}

for (const launch of [undefined, launchToken({ patient: 'pat-1' })]) {
  const flow = launch ? 'EHR launch' : 'standalone';
  const loaded = load();
  const s = userSession({ clientId: SBX_APP, approvedScopes: 'openid fhirUser launch' });
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
  const s = userSession({ clientId: SBX_APP, approvedScopes: 'openid fhirUser' });
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
  const s = userSession({ clientId: SBX_APP, approvedScopes: 'openid fhirUser' });
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
  // The list is the fallback when getOrCreateDefaultLaunchContext is unavailable.
  const session = pickerSession({});
  delete session.getOrCreateDefaultLaunchContext;
  session.defaultLaunchContexts = javaList([
    { getContextType: () => 'patient', getResourceId: () => 'pat-a' },
    { getContextType: () => 'sbx-patient-2', getResourceId: () => 'pat-b' },
  ]);
  p = pick(session);
  check('without getOrCreateDefaultLaunchContext, the list is read through its getters',
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
  delete session.getOrCreateDefaultLaunchContext;
  Object.defineProperty(session, 'defaultLaunchContexts', { get: () => { throw new Error('boom'); } });
  p = pick(session);
  check('an exception reading defaultLaunchContexts is caught', p.error, null);
  check('an exception reading defaultLaunchContexts, with no other read, adds nothing', p.persons.length, 0);
  checkLog('an exception reading the context list is logged as a warning', p.logs, 'Sandbox patient picker skipped', true);
}

{
  const session = pickerSession({});
  Object.defineProperty(session, 'defaultLaunchContexts', { get: () => { throw new Error('boom'); } });
  p = pick(session);
  check('an exception reading defaultLaunchContexts does not hide the contexts read by type',
    [p.error, p.persons.map((x) => x.associatedPatientContextResourceId)], [null, ['pat-a', 'pat-b', 'pat-c']]);
  checkLog('the unreadable context list is still logged as a warning', p.logs, 'Sandbox patient picker skipped the context list', true);
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
  delete session.getOrCreateDefaultLaunchContext;
  session.defaultLaunchContexts = javaList([patientCtxs[0], patientCtxs[1], patientCtxs[3], bad]);
  p = pick(session);
  check('an exception on the last listed context discards the whole list, so no person is added',
    [p.error, p.persons.length], [null, 0]);
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
  const calls = { launchResourceIds: [], fhirUser: [], removedScopes: [] };
  const contexts = o.contexts || [];
  const items = typeof o.approved === 'string' && o.approved !== 'throws' ? o.approved.split(' ').filter(Boolean) : null;
  calls.approved = items;
  const session = {
    getOidcClientId: () => (o.clientId === undefined ? null : o.clientId),
    // Edits the approved set in place, as Smile CDR's does (measured).
    removeApprovedScope: (scope) => {
      calls.removedScopes.push(scope);
      if (calls.approved && calls.approved.indexOf(scope) >= 0) {
        calls.approved.splice(calls.approved.indexOf(scope), 1);
      }
    },
    getDefaultLaunchContexts: () => javaList(contexts),
    addLaunchResourceId: (k, v) => calls.launchResourceIds.push([k, v]),
    setFhirUserUrl: (u) => calls.fhirUser.push(u),
    getOrCreateDefaultLaunchContext: (type) =>
      contexts.find((c) => c.contextType === type) || { contextType: type, resourceId: null },
  };
  if (o.approved === 'throws') {
    session.getApprovedScopes = () => { throw new Error('IllegalStateException: no approved scopes'); };
  } else if (o.approved !== undefined) {
    session.getApprovedScopes = () => strictJavaSet(items, misses);
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
    removedScopes: s.calls.removedScopes,
    approvedAfter: s.calls.approved ? s.calls.approved.slice() : null,
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
    { launch: pat1, params: { scope: ehrScopes } });
  check(`${clientId}: EHR launch "launch launch/patient" with Java objects drops launch/patient and gets no duplicate (was HTTP 500)`,
    [t.error, t.removedScopes, t.claims, t.launchResourceIds, t.fhirUser, smileAddLaunchScopes(t)],
    [null, ['launch/patient'], [['patient', 'pat-1']], [['patient', 'pat-1']], [AUD + '/Practitioner/guthridge-jarred'], 'ok']);
  check(`${clientId}: the scopes are read only through Java methods`, t.misses, []);
}

check('the Smile CDR model reproduces the measured 500 when launch and launch/patient both stay approved',
  smileAddLaunchScopes({ approvedAfter: ['openid', 'launch', 'launch/patient'], launchResourceIds: [['patient', 'pat-1']], claims: [] }),
  'HTTP 500');

t = javaToken({ approved: 'openid fhirUser launch patient/*.read' },
  { launch: pat1, params: { scope: 'openid fhirUser launch patient/*.read' } });
check('Java objects: EHR launch with "launch" alone adds the patient claim',
  [t.error, t.claims, t.launchResourceIds], [null, [['patient', 'pat-1']], [['patient', 'pat-1']]]);

t = javaToken({ approved: '' }, { launch: pat1, params: { scope: 'launch launch/patient' } });
check('Java objects: an empty approved set (size 0) is unknown, and a request with launch/patient skips the claim',
  [t.error, t.claims], [null, []]);

t = javaToken({ approved: '' }, { launch: pat1, params: { scope: 'openid launch' } });
check('Java objects: an empty approved set and a request without launch/patient adds the claim',
  t.claims, [['patient', 'pat-1']]);

t = javaToken({ approved: 'throws' }, { launch: pat1, params: { scope: 'openid launch launch/patient' } });
check('getApprovedScopes() throwing and no approvedScopes falls back to the request: launch/patient skips the claim',
  [t.error, t.claims], [null, []]);

t = javaToken({ approved: 'throws' }, { launch: pat1, params: { scope: 'openid launch' } });
check('getApprovedScopes() throwing and no approvedScopes falls back to the request: launch alone adds the claim',
  t.claims, [['patient', 'pat-1']]);

t = javaToken({}, { launch: pat1, params: { scope: 'launch launch/patient' } });
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
  { launch: launchToken({ patient: 'pat-1', encounter: 'enc-1' }), params: { scope: 'openid launch launch/encounter' } });
check('Java objects: with launch approved both launch/<key> are dropped, remembered or not, and both claimed',
  [t.error, t.removedScopes, t.claims, smileAddLaunchScopes(t)],
  [null, ['launch/patient', 'launch/encounter'], [['patient', 'pat-1'], ['encounter', 'enc-1']], 'ok']);

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
check('the token line names the read, the set\'s size and values, the contexts found and the requested scope string',
  sandboxLines(t.logs).map(([, m]) => m),
  ['Sandbox scopes at token generation: approved read=getApprovedScopes().contains() size=5 ' +
    'scopes=[openid, fhirUser, launch, launch/patient, patient/*.read]; contexts=none; requested=' + ehrScopes + '; EHR launch']);
check('the token line carries no launch value', sandboxLines(t.logs).some(([, m]) => m.includes('pat-1') || m.includes(pat1)), false);

t = javaToken({ clientId: 'sbx-abc123-public', approved: 'throws' }, { launch: pat1, params: {} });
check('an unreadable approved set is logged with why each read failed, and an absent request as null',
  sandboxLines(t.logs).map(([, m]) => /^Sandbox scopes at token generation: approved read=none \(getApprovedScopes\(\) threw .*IllegalStateException.*; approvedScopes.contains\(\) failed: .*; for-of approvedScopes failed: .*; String\(approvedScopes\) failed: .*\); contexts=none; requested=null; EHR launch$/.test(m)),
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
  const r = requestDetails({ javaMaps: true, launch: pat1, params: { scope: ehrScopes } });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('a diagnostic Log.info that throws does not fail token generation',
    [error, r.calls.claims, s.calls.launchResourceIds], [null, [['patient', 'pat-1']], [['patient', 'pat-1']]]);
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
  ['Sandbox scopes at context selection: approved read=getApprovedScopes().contains() size=4 ' +
    'scopes=[openid, fhirUser, launch/patient, patient/*.read]; contexts=patient via ' +
    'getOrCreateDefaultLaunchContext().resourceId, sbx-patient-2 via getOrCreateDefaultLaunchContext().resourceId, ' +
    'sbx-patient-3 via getOrCreateDefaultLaunchContext().resourceId; requested=(not available here); ' +
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
        // #136: a key whose launch/<key> is approved beside launch (a known,
        // non-empty approved list) is dropped and claimed; others as before.
        const dropped = (k) => !!(approvedList && approvedList.length && approvedList.includes('launch') &&
          approvedList.includes('launch/' + k));
        const expected = {
          error: null,
          removedScopes: keys.filter(dropped).map((k) => 'launch/' + k),
          claims: keys.filter((k) => dropped(k) || !previousSkips(k, approvedList, requestedList)).map((k) => [k, launchObj[k]]),
          launchResourceIds: keys.map((k) => [k, launchObj[k]]),
          fhirUser: mainFhirUser([practitionerCtx], launchObj),
          lines: [],
        };
        const actual = {
          error: t.error,
          removedScopes: t.removedScopes,
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
check(`non-sandbox token generation matches the previous rule, apart from #136's drop and claim, with no log line (${total} combinations)`,
  same, total);

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

// ---------------------------------------------------------------------------
// Engine shapes: what a host access policy may let the script reach
// ---------------------------------------------------------------------------

console.log('--- engine shapes: full, restricted, iterable-only ---');

/**
 * A java.util.Set<String> under a host access policy that exposes only
 * toString(): contains, iterator and size throw (or, with `undefinedMembers`,
 * read as undefined), and the set is not iterable with for-of.
 */
function toStringOnlySet(items, undefinedMembers) {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'toString') {
        return () => '[' + items.join(', ') + ']';
      }
      if (typeof prop === 'symbol' || undefinedMembers) {
        return undefined;
      }
      throw new TypeError('Unknown member ' + String(prop) + ' (host access refused)');
    },
  });
}

/** A java.util.Set<String> that for-of can iterate and that exposes no method. */
function iterableOnlySet(items) {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === Symbol.iterator) {
        return () => items[Symbol.iterator]();
      }
      if (typeof prop === 'symbol') {
        return undefined;
      }
      throw new TypeError('Unknown member ' + String(prop) + ' (host access refused)');
    },
  });
}

/** A java.util.List that exposes nothing at all. */
function opaqueList() {
  return new Proxy({}, {
    get(target, prop) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      throw new TypeError('Unknown member ' + String(prop) + ' (host access refused)');
    },
  });
}

/**
 * A UserSessionDetails as each engine shape hands it to the script:
 * - full: every Java method reachable (the strict Java set, a list with an iterator);
 * - restricted: the approved set answers only toString(), the context list nothing;
 * - iterable: the approved set only iterates with for-of, the context list nothing.
 * In every shape the documented getOrCreateDefaultLaunchContext(type) works,
 * as measured on aucore, and returns a context with a null resourceId for a
 * missing type.
 */
function shapedSession(shape, opts) {
  const o = opts || {};
  const s = javaShapedSession(Object.assign({}, o, { approved: undefined }));
  const items = (o.approved || '').split(' ').filter(Boolean);
  s.calls.approved = items;
  if (shape === 'full') {
    s.session.getApprovedScopes = () => strictJavaSet(items, s.misses);
  } else if (shape === 'restricted') {
    s.session.getApprovedScopes = () => toStringOnlySet(items);
    s.session.getDefaultLaunchContexts = () => opaqueList();
  } else {
    s.session.getApprovedScopes = () => iterableOnlySet(items);
    s.session.getDefaultLaunchContexts = () => opaqueList();
  }
  return s;
}

function shapedToken(shape, sessionOpts, requestOpts) {
  const loaded = load();
  const s = shapedSession(shape, sessionOpts);
  const r = requestDetails(Object.assign({ javaMaps: true }, requestOpts));
  let error = null;
  try {
    loaded.context.onTokenGenerating(s.session, r.details);
  } catch (e) {
    error = String(e);
  }
  return { error, claims: r.calls.claims, launchResourceIds: s.calls.launchResourceIds, fhirUser: s.calls.fhirUser,
    removedScopes: s.calls.removedScopes, approvedAfter: s.calls.approved ? s.calls.approved.slice() : null,
    misses: s.misses, logs: loaded.logs };
}

function shapedPick(shape, opts) {
  const s = shapedSession(shape, Object.assign({ clientId: 'sbx-abc123-public', contexts: patientCtxs }, opts));
  const result = pick(s.session);
  result.misses = s.misses;
  return result;
}

const standaloneScopes = 'openid fhirUser launch/patient patient/*.read';
const approvedMethod = {
  full: 'getApprovedScopes().contains()',
  restricted: 'String(getApprovedScopes())',
  iterable: 'for-of getApprovedScopes()',
};

for (const shape of ['full', 'restricted', 'iterable']) {
  for (const clientId of ['sbx-abc123-public', 'inferno-ehr']) {
    const sandbox = clientId.indexOf('sbx-') === 0;

    t = shapedToken(shape, { clientId, approved: ehrScopes, contexts: [practitionerCtx] },
      { launch: pat1, params: { scope: ehrScopes } });
    check(`${shape}, ${clientId}: EHR launch "launch launch/patient" drops launch/patient and claims it`,
      [t.error, t.removedScopes, t.claims, t.launchResourceIds, t.fhirUser, smileAddLaunchScopes(t)],
      [null, ['launch/patient'], [['patient', 'pat-1']], [['patient', 'pat-1']], [AUD + '/Practitioner/guthridge-jarred'], 'ok']);
    check(`${shape}, ${clientId}: ${sandbox ? 'one line naming the approved-scope read' : 'no sandbox line'}`,
      sandboxLines(t.logs).map(([, m]) => m.split('; ')[0].replace(/ size=.*/, '')),
      sandbox ? ['Sandbox scopes at token generation: approved read=' + approvedMethod[shape]] : []);

    t = shapedToken(shape, { clientId, approved: 'openid fhirUser launch patient/*.read', contexts: [practitionerCtx] },
      { launch: pat1, params: { scope: 'openid fhirUser launch patient/*.read' } });
    check(`${shape}, ${clientId}: EHR launch "launch" alone adds the claim`,
      [t.error, t.claims, t.launchResourceIds], [null, [['patient', 'pat-1']], [['patient', 'pat-1']]]);

    t = shapedToken(shape, { clientId, approved: 'openid fhirUser', contexts: [sbxPatientFhirUser] }, {});
    check(`${shape}, ${clientId}: standalone ${sandbox ? 'fhirUser from sbx-fhiruser' : 'sbx-fhiruser ignored, no fhirUser'}`,
      [t.error, t.fhirUser], [null, sandbox ? [AUD + '/Patient/abc123-pat-1'] : []]);

    p = shapedPick(shape, { clientId, approved: standaloneScopes });
    if (sandbox) {
      check(`${shape}: sbx standalone login offers the three patients`,
        [p.error, p.persons.map((x) => x.associatedPatientContextResourceId), p.other], [null, ['pat-a', 'pat-b', 'pat-c'], []]);
      check(`${shape}: the chooser line names the reads and the choice count`,
        sandboxLines(p.logs).map(([, m]) => [m.indexOf('approved read=' + approvedMethod[shape] + ' size=4 ') > 0,
          m.indexOf('contexts=patient via getOrCreateDefaultLaunchContext().resourceId, ' +
            'sbx-patient-2 via getOrCreateDefaultLaunchContext().resourceId, ' +
            'sbx-patient-3 via getOrCreateDefaultLaunchContext().resourceId;') > 0,
          m.endsWith('; standalone launch, 3 patient choices')]),
        [[true, true, true]]);
    } else {
      check(`${shape}, ${clientId}: no chooser and nothing logged`,
        [p.error, p.persons.length, p.other, p.logs], [null, 0, [], []]);
    }
  }

  p = shapedPick(shape, { approved: 'openid fhirUser launch launch/patient patient/*.read' });
  check(`${shape}: sbx EHR launch offers no chooser`, [p.error, p.persons.length], [null, 0]);

  t = shapedToken(shape, { approved: '' }, { launch: pat1, params: { scope: 'openid launch' } });
  check(`${shape}: an empty approved set is unknown and the request decides`, [t.error, t.claims], [null, [['patient', 'pat-1']]]);
}

t = shapedToken('full', { clientId: 'sbx-abc123-public', approved: ehrScopes, contexts: [practitionerCtx] },
  { launch: pat1, params: { scope: ehrScopes } });
check('full: the approved scopes are asked only through Java methods', t.misses, []);

p = shapedPick('restricted', { approved: standaloneScopes });
checkLog('restricted: the opaque context list is logged as a warning', p.logs,
  'Sandbox patient picker skipped the context list', true);

{
  const loaded = load();
  const s = shapedSession('restricted', { clientId: 'sbx-abc123-public', contexts: [practitionerCtx] });
  s.session.getApprovedScopes = () => toStringOnlySet(ehrScopes.split(' '), true);
  const r = requestDetails({ javaMaps: true, launch: pat1, params: { scope: ehrScopes } });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('restricted with members reading as undefined: the string form decides (drop and claim)',
    [error, s.calls.removedScopes, r.calls.claims, sandboxLines(loaded.logs).map(([, m]) => m.indexOf('approved read=String(getApprovedScopes()) size=5 ') > 0)],
    [null, ['launch/patient'], [['patient', 'pat-1']], [true]]);
}

{
  // A Map.get() refused too: the request is unknown, and the approved scopes decide.
  const loaded = load();
  const s = shapedSession('restricted', { clientId: 'sbx-abc123-public', approved: ehrScopes });
  const r = requestDetails({ launch: pat1 });
  r.details.getRequestParameters = () => opaqueList();
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('restricted with the request map refused too: launch launch/patient approved, dropped and claimed',
    [error, s.calls.removedScopes, r.calls.claims, s.calls.launchResourceIds], [null, ['launch/patient'], [['patient', 'pat-1']], [['patient', 'pat-1']]]);
}

for (const text of ['java.util.HashSet@1b2c3d', 'JavaObject[java.util.HashSet]', '[object Object]', 'launch launch/patient']) {
  const loaded = load();
  const s = javaShapedSession({});
  s.session.getApprovedScopes = () => ({ toString: () => text });
  const r = requestDetails({ launch: pat1, params: { scope: 'openid launch' } });
  loaded.context.onTokenGenerating(s.session, r.details);
  check(`a string form ${JSON.stringify(text)} is not a scope list, and the request decides`, r.calls.claims, [['patient', 'pat-1']]);
}

for (const value of ['[launch, launch/patient]', ['launch', 'launch/patient']]) {
  // A JS string or array is never what Smile CDR hands over.
  const loaded = load();
  const s = javaShapedSession({});
  s.session.getApprovedScopes = () => value;
  const r = requestDetails({ launch: pat1, params: { scope: 'openid launch' } });
  loaded.context.onTokenGenerating(s.session, r.details);
  check(`approved scopes given as the JS value ${JSON.stringify(value)} are unknown`, r.calls.claims, [['patient', 'pat-1']]);
}

console.log('--- getOrCreateDefaultLaunchContext: missing types ---');

/** A session whose getOrCreateDefaultLaunchContext knows only `known`, by exact type. */
function byTypeOnlySession(known, opts) {
  const s = shapedSession('restricted', Object.assign({ clientId: 'sbx-abc123-public', approved: standaloneScopes }, opts));
  const created = [];
  s.session.getOrCreateDefaultLaunchContext = (type) => {
    created.push(type);
    return { contextType: type, resourceId: type in known ? known[type] : null };
  };
  return { session: s.session, calls: s.calls, created };
}

{
  const s = byTypeOnlySession({ patient: 'pat-a' });
  p = pick(s.session);
  check('only a patient context (every other type null) offers no chooser', [p.error, p.persons.length], [null, 0]);
  check('the chooser reads patient, then sbx-patient-2 to sbx-patient-9, in order', s.created,
    ['patient', 'sbx-patient-2', 'sbx-patient-3', 'sbx-patient-4', 'sbx-patient-5', 'sbx-patient-6',
      'sbx-patient-7', 'sbx-patient-8', 'sbx-patient-9']);
}

{
  const s = byTypeOnlySession({ patient: 'pat-a', 'sbx-patient-3': 'pat-c', 'sbx-patient-9': 'pat-i', 'sbx-patient-5': '' });
  p = pick(s.session);
  check('a missing sbx-patient-2 or an empty one is skipped, not the end of the list',
    [p.error, p.persons.map((x) => x.associatedPatientContextResourceId)], [null, ['pat-a', 'pat-c', 'pat-i']]);
}

{
  const s = byTypeOnlySession({ 'sbx-patient-2': 'Patient/pat-b', patient: 'Patient/pat-a' });
  p = pick(s.session);
  check('resource ids are offered exactly as stored',
    p.persons.map((x) => x.associatedPatientContextResourceId), ['Patient/pat-a', 'Patient/pat-b']);
}

{
  const s = byTypeOnlySession({});
  const loaded = load();
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, requestDetails({ javaMaps: true }).details); } catch (e) { error = String(e); }
  check('null resourceIds for practitioner and sbx-fhiruser set no fhirUser', [error, s.calls.fhirUser], [null, []]);
  check('fhirUser reads practitioner, then sbx-fhiruser', s.created, ['practitioner', 'sbx-fhiruser']);
}

{
  const s = byTypeOnlySession({ practitioner: 'Practitioner/p-1', 'sbx-fhiruser': 'Patient/abc123-pat-1' });
  const loaded = load();
  loaded.context.onTokenGenerating(s.session, requestDetails({ javaMaps: true }).details);
  check('a practitioner context still wins, and sbx-fhiruser is then not read',
    [s.calls.fhirUser, s.created], [[AUD + '/Practitioner/p-1'], ['practitioner']]);
}

{
  const s = byTypeOnlySession({});
  s.session.getOrCreateDefaultLaunchContext = (type) => ({
    getResourceId: () => ({ 'sbx-fhiruser': 'Patient/abc123-pat-1' })[type] || null,
  });
  const loaded = load();
  loaded.context.onTokenGenerating(s.session, requestDetails({ javaMaps: true }).details);
  check('a context exposing only getResourceId() is read through it', s.calls.fhirUser, [AUD + '/Patient/abc123-pat-1']);
  checkLog('the token line names getResourceId() as the context read', loaded.logs,
    'contexts=sbx-fhiruser via getOrCreateDefaultLaunchContext().getResourceId()', true);
}

{
  const s = byTypeOnlySession({});
  s.session.getOrCreateDefaultLaunchContext = () => { throw new Error('IllegalStateException'); };
  const loaded = load();
  const r = requestDetails({ javaMaps: true, launch: pat1, params: { scope: 'openid launch' } });
  let error = null;
  try { loaded.context.onTokenGenerating(s.session, r.details); } catch (e) { error = String(e); }
  check('getOrCreateDefaultLaunchContext throwing fails open: no fhirUser, the claim as before',
    [error, s.calls.fhirUser, r.calls.claims], [null, [], [['patient', 'pat-1']]]);
}

{
  const s = byTypeOnlySession({ practitioner: 'Practitioner/p-1' });
  s.session.getOidcClientId = () => 'inferno-standalone';
  const loaded = load();
  loaded.context.onTokenGenerating(s.session, requestDetails({ javaMaps: true }).details);
  check('a non-sandbox standalone login logs no sandbox line', sandboxLines(loaded.logs), []);
}

console.log('--- getOrCreateDefaultLaunchContext: non-sandbox logins ---');

// getOrCreateDefaultLaunchContext(type) creates a context of any type the
// session lacks, so a non-sandbox login (Inferno, connectathon users,
// Platypus) must call it only with "practitioner", as main does.

/** Wrap a session's getOrCreateDefaultLaunchContext to record each type asked for. */
function spyCreate(session) {
  const created = [];
  const inner = session.getOrCreateDefaultLaunchContext;
  session.getOrCreateDefaultLaunchContext = (type) => {
    created.push(type);
    return inner(type);
  };
  return created;
}

for (const launch of [undefined, pat1]) {
  const flow = launch ? 'EHR launch without a practitioner' : 'standalone';
  const s = javaShapedSession({ clientId: 'inferno-ehr', approved: 'openid fhirUser launch launch/patient' });
  const created = spyCreate(s.session);
  const loaded = load();
  let error = null;
  try {
    loaded.context.onTokenGenerating(s.session, requestDetails({ javaMaps: true, launch }).details);
  } catch (e) { error = String(e); }
  check(`non-sandbox ${flow} with no practitioner context never asks for sbx-fhiruser and sets no fhirUser`,
    [error, created.includes('sbx-fhiruser'), s.calls.fhirUser], [null, false, []]);
}

for (const launch of [undefined, pat1]) {
  const flow = launch ? 'EHR launch without a practitioner' : 'standalone';
  t = token({ clientId: 'inferno-ehr', approvedScopes: 'openid fhirUser launch', contexts: [sbxPatientFhirUser] },
    { launch });
  check(`non-sandbox ${flow} with an sbx-fhiruser context present gets no fhirUser from it`,
    [t.error, t.fhirUser], [null, []]);
  t = javaToken({ clientId: 'inferno-ehr', approved: 'openid fhirUser launch', contexts: [sbxPatientFhirUser] },
    { launch });
  check(`Java objects: non-sandbox ${flow} with an sbx-fhiruser context present gets no fhirUser from it`,
    [t.error, t.fhirUser], [null, []]);
}

{
  // Every type a non-sandbox login asks getOrCreateDefaultLaunchContext for,
  // across standalone, EHR launch and context selection, in every engine shape.
  const types = new Set();
  const contextSets = [[], [practitionerCtx], [sbxPatientFhirUser], patientCtxs,
    patientCtxs.concat([sbxPatientFhirUser])];
  let runs = 0;
  let errors = 0;
  for (const shape of ['full', 'restricted', 'iterable']) {
    for (const clientId of nonSandboxClients) {
      for (const approved of approvedVariants.filter((a) => a !== 'throws').concat([standaloneScopes])) {
        for (const contexts of contextSets) {
          for (const launchObj of launchVariants) {
            const s = shapedSession(shape, { clientId, approved, contexts });
            const created = spyCreate(s.session);
            const loaded = load();
            try {
              loaded.context.onTokenGenerating(s.session, requestDetails(Object.assign({ javaMaps: true,
                params: { scope: approved } }, launchObj ? { launch: launchToken(launchObj) } : {})).details);
            } catch (e) { errors++; }
            created.forEach((x) => types.add(x));
            runs++;
          }
          const ps = shapedSession(shape, { clientId, approved, contexts });
          const created = spyCreate(ps.session);
          if (pick(ps.session).error !== null) { errors++; }
          created.forEach((x) => types.add(x));
          runs++;
        }
      }
    }
  }
  check(`non-sandbox logins ask getOrCreateDefaultLaunchContext only for practitioner (${runs} standalone, EHR and context-selection runs)`,
    [errors, Array.from(types).sort()], [0, ['practitioner']]);
}

// R16 round 5 F1 and F3: the java collection string parse splits only on
// ", ", and the log carries the requested scopes without control characters.
{
  const { context } = load();
  check('a scope holding a comma stays one entry in the java collection string',
    context.javaCollectionStringValues('[x,launch/patient, openid]'), ['x,launch/patient', 'openid']);
  check('a plain java collection string splits into its scopes',
    context.javaCollectionStringValues('[launch, launch/patient]'), ['launch', 'launch/patient']);
  check('the logged requested scopes lose newlines and line separators',
    context.loggableScopes('launch\nforged line\u2028x'), 'launch forged line x');
  check('the logged requested scopes are cut to 300 characters',
    context.loggableScopes('a'.repeat(400)).length, 303);
}

console.log(`\n${passes}/${passes + failures} checks passed`);
process.exit(failures > 0 ? 1 : 0);
