/**
 * Consent service: read-only DEFAULT partition.
 *
 * Enforces ADR 0001 (points 2, 3, 6): every session, anonymous and
 * authenticated, may READ the shared `DEFAULT` partition, but no participant
 * session may WRITE it. Smile CDR's `FHIR_ACCESS_PARTITION_NAME` gates read and
 * write together and there is no partition-scoped read-only permission, so
 * tenant principals are granted `<TENANT>,DEFAULT` for the authenticated
 * `DEFAULT` read and this consent service supplies the missing half: it rejects
 * write verbs whose resolved request partition is `DEFAULT`.
 *
 * Config keys, on the FHIR REST Endpoint module (NOT persistence):
 *   consent_service.enabled:     true
 *   consent_service.script.file: classpath:config_seeding/consent-default-readonly.js
 *
 * Mounted on the endpoint rather than on storage deliberately. Package registry
 * seeding, IG installs and every other internal DAO write into DEFAULT happen
 * below the REST layer, so an endpoint mount cannot stop the node coming up. A
 * storage mount would put this script in the path of startup seeding, where a
 * rejection or a script error means the node never becomes healthy. Participant
 * traffic is all REST, so the endpoint mount loses no coverage that matters.
 *
 * Docs: https://smilecdr.com/docs/security/consent_service_javascript.html
 *
 * OBSERVE MODE. `ENFORCE` below is false on first deploy. The script then logs
 * every decision it would have made and rejects nothing, which is how the
 * accessor probing and the curator exemption get verified against the deployed
 * build before they can break anything. Read the logs, confirm the partition
 * resolves and that no curator or loader traffic appears as a would-reject, then
 * flip ENFORCE to true and redeploy. See docs/consent-service-rollout.md.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** false: log decisions, reject nothing. true: enforce. */
var ENFORCE = false;

/** Partition whose writes are protected. Reads are never blocked. */
var PROTECTED_PARTITION = 'DEFAULT';

/** Prefix on every log line from this script, so the rollout is greppable. */
var TAG = '[consent-default-readonly]';

/**
 * Authorities that identify a principal allowed to write DEFAULT.
 *
 * ADR 0001 names four team-internal accounts as exempt: ADMIN, DevTester,
 * placer and filler. Audited against the live aucore node on 2026-08-19, they
 * do not share a single marker:
 *
 *   ADMIN, XUN            ROLE_SUPERUSER
 *   FILLER, PLACER        ROLE_FHIR_CLIENT_SUPERUSER
 *   DEVTESTER             neither, and no FHIR_ACCESS_PARTITION_ALL
 *
 * DEVTESTER curates the shared conformance resources with
 * FHIR_WRITE_ALL_OF_TYPE on CodeSystem, ConceptMap, StructureDefinition and
 * ValueSet, all of which live in DEFAULT. The superuser roles alone would
 * therefore have rejected exactly the account whose whole job is writing
 * DEFAULT.
 *
 * FHIR_UPLOAD_EXTERNAL_TERMINOLOGY and FHIR_MODIFY_SEARCH_PARAMETERS cover it.
 * Both change server-wide behaviour rather than tenant data, no participant
 * account holds either (the one non-curator that can currently write DEFAULT,
 * PLATYPUS-DEMO-PATIENT, has neither), and matching on capability keeps this
 * from becoming a username list that the next curator account has to be added
 * to by hand.
 */
var CURATOR_AUTHORITIES = [
  'ROLE_SUPERUSER',
  'ROLE_FHIR_CLIENT_SUPERUSER',
  'FHIR_ACCESS_PARTITION_ALL',
  'FHIR_UPLOAD_EXTERNAL_TERMINOLOGY',
  'FHIR_MODIFY_SEARCH_PARAMETERS',
];

/**
 * HTTP verbs that can never modify state. Everything else is treated as a write
 * unless the REST operation type says otherwise.
 */
var READ_VERBS = { GET: true, HEAD: true, OPTIONS: true };

/**
 * REST operation types that are reads despite arriving as POST. A FHIR search
 * can be POSTed to `[type]/_search`, and blocking that would break exactly the
 * authenticated DEFAULT read this change exists to enable.
 */
var READ_OPERATIONS = {
  READ: true,
  VREAD: true,
  VLREAD: true,
  SEARCH_TYPE: true,
  SEARCH_SYSTEM: true,
  HISTORY_INSTANCE: true,
  HISTORY_TYPE: true,
  HISTORY_SYSTEM: true,
  GET_PAGE: true,
  METADATA: true,
};

/** REST operation types that modify state. */
var WRITE_OPERATIONS = {
  CREATE: true,
  UPDATE: true,
  PATCH: true,
  DELETE: true,
  // A transaction or batch can carry write entries, so gate the whole bundle.
  TRANSACTION: true,
  BATCH: true,
};

// ---------------------------------------------------------------------------
// Accessor probing
//
// theRequestDetails is a RequestDetailsJson. Smile CDR documents the callback
// signatures but not this object's accessors, and they have moved between
// releases. Every read below is therefore attempted and allowed to fail, and
// what resolved is logged in observe mode. Nothing here may throw: an exception
// out of consentStartOperation fails the request, and this script sits in front
// of every REST call on the node.
// ---------------------------------------------------------------------------

/**
 * Log without ever being able to fail a request.
 *
 * Log is provided by Smile CDR's JavaScript environment and smart-post-authorize.js
 * relies on it, but this script runs in front of every REST call on the module,
 * and the whole design is that nothing in it can take the endpoint down. An
 * unguarded Log call inside a catch block would do exactly that if the global
 * were ever absent or renamed.
 */
function logLine(theLevel, theMessage) {
  try {
    if (typeof Log === 'undefined' || !Log) {
      return;
    }
    if (typeof Log[theLevel] === 'function') {
      Log[theLevel](theMessage);
    }
  } catch (e) {
    // Nothing useful left to do: logging is the thing that failed.
  }
}

/** Call a no-arg accessor by name, returning null rather than throwing. */
function tryAccessor(theObject, theName) {
  try {
    if (!theObject || typeof theObject[theName] !== 'function') {
      return null;
    }
    var value = theObject[theName]();
    if (value === null || value === undefined) {
      return null;
    }
    value = '' + value;
    return value.length > 0 ? value : null;
  } catch (e) {
    return null;
  }
}

/**
 * The partition the request targets, or null if it cannot be determined.
 *
 * Tries the direct accessors first, then falls back to the tenant segment of
 * the URL, which is where URL-based multitenancy puts it
 * (https://host/aucore/fhir/<PARTITION>/...).
 */
function resolvePartition(theRequestDetails) {
  var direct = tryAccessor(theRequestDetails, 'getTenantId')
    || tryAccessor(theRequestDetails, 'getPartitionName');
  if (direct) {
    return direct;
  }

  var url = tryAccessor(theRequestDetails, 'getFhirServerBase')
    || tryAccessor(theRequestDetails, 'getCompleteUrl')
    || tryAccessor(theRequestDetails, 'getRequestPath');
  if (!url) {
    return null;
  }

  // Take the segment after "/fhir/". Strip any query string first.
  var path = ('' + url).split('?')[0];
  var marker = path.indexOf('/fhir/');
  if (marker < 0) {
    return null;
  }
  var rest = path.substring(marker + '/fhir/'.length);
  var segment = rest.split('/')[0];
  return segment && segment.length > 0 ? segment : null;
}

/**
 * True if this request modifies state.
 *
 * The REST operation type is authoritative when it resolves. The HTTP verb is
 * the fallback, and it is deliberately conservative: an unrecognised verb
 * counts as a write.
 */
function isWrite(theRequestDetails) {
  var op = tryAccessor(theRequestDetails, 'getRestOperationType');
  if (op) {
    var normalised = op.toUpperCase();
    if (READ_OPERATIONS[normalised] === true) {
      return false;
    }
    if (WRITE_OPERATIONS[normalised] === true) {
      return true;
    }
    // An extended operation ($everything, $validate, $expunge, ...). Fall
    // through to the verb: the read-only ones are GET or POST, and POST here
    // stays conservative.
  }

  var verb = tryAccessor(theRequestDetails, 'getRequestType')
    || tryAccessor(theRequestDetails, 'getHttpMethod');
  if (verb && READ_VERBS[verb.toUpperCase()] === true) {
    return false;
  }
  return true;
}

/** True if this principal is allowed to write the protected partition. */
function isCurator(theUserSession) {
  if (!theUserSession || typeof theUserSession.hasAuthority !== 'function') {
    return false;
  }
  for (var i = 0; i < CURATOR_AUTHORITIES.length; i++) {
    try {
      if (theUserSession.hasAuthority(CURATOR_AUTHORITIES[i])) {
        return true;
      }
    } catch (e) {
      // Accessor shape differs on this build; treat as not a curator and keep
      // checking the remaining authorities.
    }
  }
  return false;
}

/** Short principal description for the log line. Never throws. */
function describePrincipal(theUserSession, theClientSession) {
  var user = tryAccessor(theUserSession, 'getUsername')
    || tryAccessor(theUserSession, 'getUserId');
  var client = tryAccessor(theClientSession, 'getClientId')
    || tryAccessor(theClientSession, 'getClientName');
  if (user && client) {
    return user + ' via ' + client;
  }
  return user || client || 'anonymous';
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/**
 * Runs once at the start of every operation.
 *
 * Every path ends in authorized() or reject(), never proceed(). authorized()
 * short-circuits the per-resource consent callbacks, which the Smile CDR docs
 * call out as a significant performance cost; this node serves bulk reads of
 * the curated dataset, so skipping them matters. That is also why
 * consentCanSeeResource and consentWillSeeResource are not defined here: all
 * five callbacks are optional, and they would be unreachable.
 */
function consentStartOperation(theRequestDetails, theUserSession, theContextServices, theClientSession) {
  var partition;
  var write;
  var curator;

  try {
    partition = resolvePartition(theRequestDetails);
    write = isWrite(theRequestDetails);
    curator = isCurator(theUserSession);
  } catch (e) {
    // Defensive: nothing above should throw, but a script error here would
    // otherwise take out every request on the node.
    logLine('warn', TAG + ' evaluation failed, allowing request: ' + e);
    theContextServices.authorized();
    return;
  }

  if (partition === null) {
    // Fail open, loudly. The accessors did not resolve on this build. Failing
    // closed would reject every write on every tenant, including the curated
    // data loaders; failing open restores exactly the behaviour that existed
    // before this script, which is a state we already live with.
    logLine('warn', TAG + ' could not resolve the request partition, allowing '
      + 'request. This script is not protecting anything until that is fixed.');
    theContextServices.authorized();
    return;
  }

  if (partition !== PROTECTED_PARTITION || !write || curator) {
    theContextServices.authorized();
    return;
  }

  var summary = TAG + ' write to ' + PROTECTED_PARTITION + ' by '
    + describePrincipal(theUserSession, theClientSession);

  if (!ENFORCE) {
    logLine('info', summary + ' WOULD BE REJECTED (observe mode)');
    theContextServices.authorized();
    return;
  }

  // reject() takes no message, so the reason only exists in the log. A
  // participant sees a bare 403; docs/consent-service-rollout.md records that.
  logLine('info', summary + ' rejected');
  theContextServices.reject();
}
