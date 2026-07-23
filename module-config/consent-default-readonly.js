/**
 * Consent service: read-only DEFAULT partition.
 *
 * Enforces ADR 0001 (points 2, 3, 6): every session — anonymous and
 * authenticated — may READ the shared `DEFAULT` partition, but no participant
 * session may WRITE it. Because Smile CDR's `FHIR_ACCESS_PARTITION_NAME` gates
 * read and write together (there is no partition-scoped read-only permission),
 * tenant principals are granted `<TENANT>,DEFAULT` for the authenticated
 * `DEFAULT` read, and this consent service supplies the missing half: it rejects
 * write verbs whose resolved request partition is `DEFAULT`.
 *
 * Config key: `consent_service.script.file` on the persistence module.
 * Docs: https://smilecdr.com/docs/security/consent_service.html
 *
 * STATUS: reference implementation for ADR 0001 sign-off. The tenant/partition
 * and role accessors below are the parts most likely to differ across Smile CDR
 * releases — verify each against the deployed version and exercise the Phase 0
 * matrix (incl. a DEFAULT-write-rejection case and a curator-exemption case)
 * before wiring into any node. Not yet referenced by simplified-multinode.yaml.
 */

// Partition whose writes are protected. Reads are never blocked.
var PROTECTED_PARTITION = 'DEFAULT';

// Write operations to reject on the protected partition. Reads (READ, VLREAD,
// SEARCH_TYPE, SEARCH_SYSTEM, HISTORY_*, GET_PAGE, metadata) are always allowed.
var WRITE_OPERATIONS = {
  CREATE: true,
  UPDATE: true,
  PATCH: true,
  DELETE: true,
  // A transaction/batch can carry write entries; gate it and let per-entry
  // partition resolution below catch the writes. (A read-only batch is rare
  // from a participant and still resolves per entry.)
  TRANSACTION: true,
  BATCH: true,
};

/**
 * Curator exemption: the Sparked-team accounts that legitimately maintain the
 * shared dataset keep write access to DEFAULT. Identify them by a role/authority
 * rather than by username so new curator accounts inherit it. Adjust the marker
 * to match how curator accounts are provisioned (e.g. a superuser role or an
 * explicit custom authority).
 */
function isCurator(theRequestDetails) {
  try {
    var session = theRequestDetails.getUserSession && theRequestDetails.getUserSession();
    if (!session) return false;
    if (session.hasAuthority && session.hasAuthority('ROLE_FHIR_CLIENT_SUPERUSER')) return true;
    if (session.hasAuthority && session.hasAuthority('ROLE_SUPERUSER')) return true;
    return false;
  } catch (e) {
    // Fail closed: if we cannot prove curator status, treat as a participant.
    return false;
  }
}

/** The tenant/partition segment of the request URL (e.g. "DEFAULT", "PLATYPUS"). */
function requestPartition(theRequestDetails) {
  if (theRequestDetails.getTenantId) {
    return theRequestDetails.getTenantId();
  }
  if (theRequestDetails.getPartitionName) {
    return theRequestDetails.getPartitionName();
  }
  return null;
}

function isWriteOperation(theRequestDetails) {
  var op = theRequestDetails.getRestOperationType
    ? '' + theRequestDetails.getRestOperationType()
    : '';
  // RestOperationType may serialise as e.g. "CREATE" or "create"; normalise.
  return WRITE_OPERATIONS[op.toUpperCase()] === true;
}

/**
 * Called once at the start of every operation. Reject participant writes whose
 * request partition is DEFAULT; proceed for everything else (all reads, all
 * writes to a real tenant, and all curator activity).
 */
function consentStartOperation(theRequestDetails, theContextServices) {
  var partition = requestPartition(theRequestDetails);
  if (partition !== PROTECTED_PARTITION) {
    return theContextServices.proceed();
  }
  if (!isWriteOperation(theRequestDetails)) {
    return theContextServices.proceed(); // reads of DEFAULT are always allowed
  }
  if (isCurator(theRequestDetails)) {
    return theContextServices.proceed(); // team curator accounts maintain DEFAULT
  }
  return theContextServices.reject(
    'The DEFAULT partition is read-only (ADR 0001). Write your data to your own tenant.'
  );
}

// Reads are unrestricted: authorise resources without per-resource filtering.
function canSeeResource(theRequestDetails, theResource, theContextServices) {
  return theContextServices.authorized();
}

function willSeeResource(theRequestDetails, theResource, theContextServices) {
  return theContextServices.proceed();
}
