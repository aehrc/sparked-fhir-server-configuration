/**
 * Unit tests for module-config/consent-default-readonly.js.
 *
 * The consent service sits in front of every REST request on the node, so its
 * decision logic is worth testing before it is ever deployed. This loads the
 * real script into a sandbox with a stubbed Log global and drives
 * consentStartOperation with mock Smile CDR objects.
 *
 * What this can and cannot prove: the decision matrix is covered exactly, but
 * the accessor names on the live RequestDetailsJson are not, because that
 * object is not documented. The mocks below encode what the script is willing
 * to accept, not what the deployed build offers. Observe mode on the node is
 * what settles that; see docs/consent-service-rollout.md.
 *
 * Run: node scripts/test_consent_default_readonly.js
 * No dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'module-config', 'consent-default-readonly.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

let failures = 0;
let passes = 0;

/** Load a fresh copy of the consent script, optionally in enforcing mode. */
function load(enforce) {
  const logs = [];
  const context = {
    Log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: SCRIPT });
  // Set both ways, never just on: otherwise the observe-mode tests silently
  // inherit whatever the committed ENFORCE default happens to be.
  vm.runInContext(`ENFORCE = ${enforce ? 'true' : 'false'};`, context);
  return { context, logs };
}

/** Mock RequestDetailsJson exposing only the accessors named in `accessors`. */
function requestDetails(accessors) {
  const mock = {};
  for (const [name, value] of Object.entries(accessors)) {
    mock[name] = () => value;
  }
  return mock;
}

/** Mock UserSessionDetailsJson. */
function userSession(username, authorities) {
  return {
    getUsername: () => username,
    hasAuthority: (a) => (authorities || []).includes(a),
  };
}

/** Mock ClientSessionDetailsJson. */
function clientSession(clientId) {
  return { getClientId: () => clientId };
}

/**
 * Drive one request through the script and report which context service the
 * script called: 'authorized', 'rejected', or 'proceeded'.
 */
function decide(loaded, details, session, client) {
  let outcome = null;
  const contextServices = {
    authorized: () => { outcome = 'authorized'; },
    reject: () => { outcome = 'rejected'; },
    proceed: () => { outcome = 'proceeded'; },
  };
  loaded.context.consentStartOperation(details, session, contextServices, client);
  return outcome;
}

function check(name, actual, expected) {
  if (actual === expected) {
    passes++;
    console.log(`[PASS] ${name}`);
  } else {
    failures++;
    console.log(`[FAIL] ${name}: got ${actual}, expected ${expected}`);
  }
}

function checkLog(name, logs, needle, shouldMatch) {
  const found = logs.some(([, message]) => message.includes(needle));
  if (found === shouldMatch) {
    passes++;
    console.log(`[PASS] ${name}`);
  } else {
    failures++;
    console.log(`[FAIL] ${name}: ${shouldMatch ? 'expected' : 'did not expect'} a log line containing "${needle}"`);
    logs.forEach(([level, message]) => console.log(`         ${level}: ${message}`));
  }
}

// ---------------------------------------------------------------------------
// Enforcing mode: the decision matrix
// ---------------------------------------------------------------------------

console.log('--- enforcing mode ---');

const participant = userSession('platypus-demo-patient', [
  'ROLE_FHIR_CLIENT', 'FHIR_ALL_READ', 'FHIR_ALL_WRITE', 'FHIR_ACCESS_PARTITION_NAME',
]);
const superuser = userSession('admin', ['ROLE_SUPERUSER']);
const partitionAdmin = userSession('loader', ['ROLE_FHIR_CLIENT', 'FHIR_ACCESS_PARTITION_ALL']);

check('anonymous read of DEFAULT is allowed',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'SEARCH_TYPE', getRequestType: 'GET' }), null, null),
  'authorized');

check('anonymous write to DEFAULT is rejected',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE', getRequestType: 'POST' }), null, null),
  'rejected');

check('participant read of DEFAULT is allowed',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'READ', getRequestType: 'GET' }), participant, null),
  'authorized');

check('participant write to DEFAULT is rejected',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE', getRequestType: 'POST' }), participant, null),
  'rejected');

check('participant write to their own tenant is allowed',
  decide(load(true), requestDetails({ getTenantId: 'FHIRFROG', getRestOperationType: 'CREATE', getRequestType: 'POST' }), participant, clientSession('frog-runner')),
  'authorized');

check('participant delete in DEFAULT is rejected',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'DELETE', getRequestType: 'DELETE' }), participant, null),
  'rejected');

check('participant transaction against DEFAULT is rejected',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'TRANSACTION', getRequestType: 'POST' }), participant, null),
  'rejected');

check('participant transaction against their own tenant is allowed',
  decide(load(true), requestDetails({ getTenantId: 'FHIRFROG', getRestOperationType: 'TRANSACTION', getRequestType: 'POST' }), participant, null),
  'authorized');

check('POSTed search of DEFAULT is allowed',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'SEARCH_TYPE', getRequestType: 'POST' }), participant, null),
  'authorized');

check('capability statement on DEFAULT is allowed',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'METADATA', getRequestType: 'GET' }), null, null),
  'authorized');

check('superuser write to DEFAULT is allowed',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE', getRequestType: 'POST' }), superuser, null),
  'authorized');

check('FHIR_ACCESS_PARTITION_ALL write to DEFAULT is allowed (the data loaders)',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'UPDATE', getRequestType: 'PUT' }), partitionAdmin, null),
  'authorized');

check('backend client with no user session writing its own tenant is allowed',
  decide(load(true), requestDetails({ getTenantId: 'FHIRFROG', getRestOperationType: 'CREATE', getRequestType: 'POST' }), null, clientSession('frog-runner')),
  'authorized');

check('backend client with no user session writing DEFAULT is rejected',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE', getRequestType: 'POST' }), null, clientSession('frog-runner')),
  'rejected');

// ---------------------------------------------------------------------------
// Accessor fallbacks
// ---------------------------------------------------------------------------

console.log('--- accessor fallbacks ---');

check('partition falls back to getPartitionName',
  decide(load(true), requestDetails({ getPartitionName: 'DEFAULT', getRestOperationType: 'CREATE' }), participant, null),
  'rejected');

check('partition falls back to the URL tenant segment',
  decide(load(true), requestDetails({ getCompleteUrl: 'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient', getRequestType: 'POST' }), participant, null),
  'rejected');

check('URL fallback reads a non-DEFAULT tenant correctly',
  decide(load(true), requestDetails({ getCompleteUrl: 'https://smile.sparked-fhir.com/aucore/fhir/FHIRFROG/Patient', getRequestType: 'POST' }), participant, null),
  'authorized');

check('URL fallback ignores the query string',
  decide(load(true), requestDetails({ getRequestPath: '/aucore/fhir/DEFAULT/Patient?_count=1', getRequestType: 'GET' }), participant, null),
  'authorized');

check('write is inferred from the verb when the operation type is unknown',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRequestType: 'PATCH' }), participant, null),
  'rejected');

check('an extended operation POSTed to DEFAULT is treated as a write',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'EXTENDED_OPERATION_TYPE', getRequestType: 'POST' }), participant, null),
  'rejected');

check('an extended operation GET on DEFAULT is treated as a read',
  decide(load(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'EXTENDED_OPERATION_TYPE', getRequestType: 'GET' }), participant, null),
  'authorized');

const unresolvable = load(true);
check('an unresolvable partition fails open',
  decide(unresolvable, requestDetails({ getRequestType: 'POST' }), participant, null),
  'authorized');
checkLog('an unresolvable partition warns loudly', unresolvable.logs, 'could not resolve the request partition', true);

const throwing = load(true);
check('an accessor that throws does not fail the request',
  decide(throwing, { getTenantId: () => { throw new Error('no such method'); }, getRequestType: () => 'POST' }, participant, null),
  'authorized');

const hostileSession = load(true);
check('a user session whose hasAuthority throws is treated as a participant',
  decide(hostileSession,
    requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE' }),
    { getUsername: () => 'odd', hasAuthority: () => { throw new Error('unsupported'); } },
    null),
  'rejected');

// ---------------------------------------------------------------------------
// Observe mode
// ---------------------------------------------------------------------------

console.log('--- observe mode ---');

const observed = load(false);
check('observe mode allows a write that would be rejected',
  decide(observed, requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE', getRequestType: 'POST' }), participant, clientSession('platypus-demo')),
  'authorized');
checkLog('observe mode logs the would-be rejection', observed.logs, 'WOULD BE REJECTED', true);
checkLog('observe mode names the principal', observed.logs, 'platypus-demo-patient via platypus-demo', true);

const observedAllowed = load(false);
decide(observedAllowed, requestDetails({ getTenantId: 'FHIRFROG', getRestOperationType: 'CREATE', getRequestType: 'POST' }), participant, null);
checkLog('observe mode stays quiet for allowed writes', observedAllowed.logs, 'WOULD BE REJECTED', false);

// ---------------------------------------------------------------------------
// Logging cannot fail a request
// ---------------------------------------------------------------------------

console.log('--- logging is guarded ---');

/** Load the script into a sandbox with no Log global at all. */
function loadWithoutLog(enforce) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: SCRIPT });
  vm.runInContext(`ENFORCE = ${enforce ? 'true' : 'false'};`, context);
  return { context, logs: [] };
}

check('a rejection still happens with no Log global',
  decide(loadWithoutLog(true), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE' }), participant, null),
  'rejected');

check('observe mode still allows with no Log global',
  decide(loadWithoutLog(false), requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE' }), participant, null),
  'authorized');

check('the fail-open path survives no Log global',
  decide(loadWithoutLog(true), requestDetails({ getRequestType: 'POST' }), participant, null),
  'authorized');

const brokenLog = (() => {
  const context = { Log: { info: () => { throw new Error('appender down'); },
                           warn: () => { throw new Error('appender down'); } } };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: SCRIPT });
  vm.runInContext('ENFORCE = true;', context);
  return { context, logs: [] };
})();
check('a Log implementation that throws does not fail the request',
  decide(brokenLog, requestDetails({ getTenantId: 'DEFAULT', getRestOperationType: 'CREATE' }), participant, null),
  'rejected');

// ---------------------------------------------------------------------------
// Shipping state
// ---------------------------------------------------------------------------

console.log('--- shipping state ---');

const pristine = vm.createContext({ Log: { info() {}, warn() {}, error() {} } });
vm.runInContext(SOURCE, pristine, { filename: SCRIPT });
check('the committed script ships enforcing',
  vm.runInContext('ENFORCE', pristine), true);

console.log(`\n${passes}/${passes + failures} checks passed`);
process.exit(failures > 0 ? 1 : 0);
