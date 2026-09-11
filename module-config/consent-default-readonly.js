/**
 * Consent service: read-only DEFAULT partition.
 *
 * Enforces ADR 0001 (points 2, 3, 6): every session, anonymous and
 * authenticated, may READ the shared `DEFAULT` partition, but no participant
 * session may WRITE it. Smile CDR's `FHIR_ACCESS_PARTITION_NAME` gates read and
 * write together and there is no partition-scoped read-only permission, so
 * tenant principals are granted `<TENANT>,DEFAULT` for the authenticated
 * `DEFAULT` read and this consent service supplies the missing half: it rejects
 * writes whose resolved request partition is `DEFAULT`.
 *
 * Read versus write is decided from the REST operation type, then, for an
 * extended operation, from the operation name against an allowlist, and only
 * then from the HTTP verb. The verb alone is not enough: `$validate` and
 * `$expunge` are both POSTs and only one of them writes.
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
 * ENFORCING. `ENFORCE` is true: writes to DEFAULT from non-curator principals
 * are rejected with a bare 403 and logged. It shipped in observe mode first and
 * ran that way on live aucore from 2026-08-19, which is how the accessor probing
 * and the curator exemption were verified against the deployed build. Set
 * ENFORCE back to false to return to logging without blocking, or
 * consent_service.enabled to false to take the script out of the request path
 * entirely. See docs/consent-service-rollout.md.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** false: log decisions, reject nothing. true: enforce. */
var ENFORCE = true;

/** Partition whose writes are protected. Reads are never blocked. */
var PROTECTED_PARTITION = 'DEFAULT';

/** Prefix on every log line from this script, so the rollout is greppable. */
var TAG = '[consent-default-readonly]';

/**
 * Authorities that identify a principal allowed to write DEFAULT.
 *
 * FHIR_ACCESS_PARTITION_ALL is the load-bearing one, and the reason this list is
 * not just the superuser roles: participants are provisioned with
 * FHIR_ACCESS_PARTITION_NAME:<TENANT>, while curator and admin principals get
 * partition-wide access. That makes it the discriminator that actually tracks
 * how accounts are provisioned in this repo, rather than one that happens to
 * match today's admin account.
 */
var CURATOR_AUTHORITIES = [
  'ROLE_SUPERUSER',
  'ROLE_FHIR_CLIENT_SUPERUSER',
  'FHIR_ACCESS_PARTITION_ALL',
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
 *
 * VALIDATE is here for the same reason. HAPI gives `$validate` its own
 * operation type rather than folding it in with the extended operations, so on
 * a build that reports it that way a POST of `[type]/$validate` never reaches
 * the operation-name allowlist below and has to be recognised here. `$validate`
 * runs the validator over a body the caller supplied and returns an
 * OperationOutcome; it persists nothing, whatever its mode parameter says.
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
  VALIDATE: true,
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
  // HAPI gives the metadata-editing operations their own types, the way it does
  // VALIDATE. Naming them here means a build that reports the type never
  // depends on the operation name to catch them, and `$meta` being an allowed
  // read cannot be mistaken for its two writing siblings.
  META_ADD: true,
  META_DELETE: true,
};

/**
 * Extended operations that cannot modify state, keyed by operation name.
 *
 * An extended operation is a read or a write depending on which operation it
 * is, and nothing else: `$expand` and `$expunge` arrive over the same verb, at
 * the same operation type, and differ only by name. The verb cannot separate
 * them, which is why this list exists.
 *
 * This is an ALLOWLIST and not a denylist, and the distinction is the whole
 * point. An operation that is not on it is treated as a write. Smile CDR and
 * HAPI ship operations this node does not serve today, an IG install can add
 * more, and a later release can add one that writes; naming the writers instead
 * would mean every operation nobody thought of defaults to allowed, which is
 * how a curated partition ends up edited by something that was never reviewed.
 * Adding an entry here is therefore a deliberate decision that the operation's
 * whole contract is to compute an answer out of data that is already stored.
 *
 * On the list: `$validate` runs the validator; `$expand`, `$lookup`,
 * `$validate-code`, `$translate` and `$subsumes` answer terminology questions;
 * `$everything`, `$summary`, `$docref`, `$diff`, `$last-n`, `$stats` and
 * `$binary-access-read` gather, compare or count resources that are already
 * there; `$meta` reads tags and security labels; `$graphql` is query-only,
 * HAPI implementing no mutation half of GraphQL.
 *
 * Deliberately off it, each because it writes: `$expunge`, `$reindex`,
 * `$mark-all-resources-for-reindexing` and `$perform-reindexing-pass` destroy
 * or rewrite storage; `$meta-add` and `$meta-delete` edit resource metadata;
 * `$apply-codesystem-delta-add` and `$apply-codesystem-delta-remove` edit a
 * CodeSystem in place; the `$partition-management-*` family edits the partition
 * map this script is protecting; `$import` loads data, `$export` writes a bulk
 * job, and `$process-message` and `$submit-data` hand a payload to something
 * that stores it.
 */
var READ_OPERATION_NAMES = {
  '$validate': true,
  '$expand': true,
  '$lookup': true,
  '$validate-code': true,
  '$translate': true,
  '$subsumes': true,
  '$everything': true,
  '$summary': true,
  '$docref': true,
  '$meta': true,
  '$graphql': true,
  '$diff': true,
  '$last-n': true,
  '$stats': true,
  '$binary-access-read': true,
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
 * Fold an operation type into the spelling READ_OPERATIONS is keyed by.
 *
 * The build running today reports the enum constant (`SEARCH_TYPE`), which is
 * how the POSTed-search exemption works at all, but the same value has a wire
 * code spelling (`search-type`) and this object is not documented. Uppercasing
 * and turning hyphens into underscores accepts either, and costs nothing if
 * only one ever arrives.
 */
function normaliseOperationType(theValue) {
  return ('' + theValue).toUpperCase().replace(/-/g, '_');
}

/**
 * The extended operation's name, as a single leading `$` and lower case, or
 * null if it cannot be read.
 *
 * `getOperation` is the usual accessor; the other two are tried for the same
 * reason resolvePartition tries three, which is that RequestDetailsJson is
 * undocumented and its accessors have moved between releases. The `$` is
 * stripped and put back rather than matched, because a build may report the
 * name with it or without it, and the leading `$` on every key also means a
 * name can never collide with something inherited from Object.prototype.
 */
function resolveOperationName(theRequestDetails) {
  var name = tryAccessor(theRequestDetails, 'getOperation')
    || tryAccessor(theRequestDetails, 'getOperationType')
    || tryAccessor(theRequestDetails, 'getExtendedOperationName');
  if (!name) {
    return null;
  }

  var trimmed = ('' + name).toLowerCase().replace(/^\s+/, '').replace(/\s+$/, '');
  while (trimmed.length > 0 && trimmed.charAt(0) === '$') {
    trimmed = trimmed.substring(1);
  }
  return trimmed.length > 0 ? '$' + trimmed : null;
}

/**
 * True if this request modifies state.
 *
 * The REST operation type is authoritative when it resolves to one of the two
 * tables. An extended operation resolves to neither, so the operation name
 * decides, and the HTTP verb is the last resort: deliberately conservative,
 * with an unrecognised verb counting as a write.
 *
 * The name check runs after WRITE_OPERATIONS on purpose. A request whose
 * operation type already says CREATE stays a write whatever name comes back
 * with it, so the allowlist can only ever exempt a request the operation type
 * left undecided; it can never overturn a write the type identified.
 */
function isWrite(theRequestDetails) {
  var op = tryAccessor(theRequestDetails, 'getRestOperationType');
  if (op) {
    var normalised = normaliseOperationType(op);
    if (READ_OPERATIONS[normalised] === true) {
      return false;
    }
    if (WRITE_OPERATIONS[normalised] === true) {
      return true;
    }
    // An extended operation ($everything, $validate, $expunge, ...). Which one
    // it is decides, so fall through to the name.
  }

  var operation = resolveOperationName(theRequestDetails);
  if (operation && READ_OPERATION_NAMES[operation] === true) {
    return false;
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
