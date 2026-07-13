# ADR 0001: Partition-based multitenancy with a read-only DEFAULT tenant

- **Status**: Proposed (requires DTR and Brett Esler sign-off per repository governance)
- **Date**: 2026-07-13
- **Deciders**: DTR, Brett Esler
- **Technical scope**: Sparked Dev FHIR Server (`smile.sparked-fhir.com`), nodes `ereq` and `aucore`. The `hl7au` node is explicitly out of scope for this ADR.

## Context

The Sparked Dev FHIR Server runs Smile CDR 2025.11.R02 with FHIR data partitioning already enabled on every node:

- `partitioning.enabled: true` and `partitioning.partition_selection_mode: REQUEST_TENANT` on the persistence module
- `partitioning.tenant_identification_strategy: URL_BASED` on the FHIR endpoint module

This is why all endpoint URLs carry a tenant segment today (`.../fhir/DEFAULT`). Only the built-in `DEFAULT` partition is in use, so the server is effectively single-tenant: all participants share one dataset.

That shared dataset creates recurring friction, most visibly at connectathons and test events:

1. Participants regularly ask for read/write access, especially for AU eRequesting medications workflows where placer/filler flows require creating and updating MedicationRequest, Task, and related resources.
2. Participants want to load their own custom test data and read it back reliably. In the shared partition their data is visible to everyone, can conflict with other participants' data, and is removed whenever the shared dataset is cleared between events.
3. Granting write access to the shared data means any participant can modify or delete the curated AU Core test data that other participants (and read-only demonstrations) depend on.

Smile CDR's permission model is partition-aware but coarse: `FHIR_ACCESS_PARTITION_NAME` gates which partitions a session may touch (it "includes both read and write operations"), while read/write authority comes from separate global permissions (`FHIR_ALL_READ`, `FHIR_ALL_WRITE`). Permissions combine additively, so a single session cannot natively hold "read-only on partition A, read-write on partition B". There are no partition-scoped read or write permissions in the current release.

## Decision

Adopt partition-per-tenant multitenancy with a read-only shared tenant, enforced through the existing permission model. No new modules, no custom interceptors, and no server restarts are required for tenant lifecycle operations.

1. **Tenants are Smile CDR partitions.** Each vendor or connectathon scenario that needs write access receives its own partition (for example `VENDOR-ACME`, `SCENARIO-EREQ-MEDS`), created with the `$partition-management-create-partition` operation. Tenant URLs follow automatically from the existing URL-based tenant identification (`.../ereq/fhir/VENDOR-ACME`).
2. **DEFAULT becomes read-only for non-admin principals.** The curated shared dataset stays in `DEFAULT`. Anonymous read access to `DEFAULT` is unchanged. `FHIR_ALL_WRITE` and `FHIR_TRANSACTION` are removed from every non-admin principal that holds `FHIR_ACCESS_PARTITION_NAME: DEFAULT`. Test data loading continues through admin credentials.
3. **Vendor principals are scoped to their tenant.** A vendor's users and OIDC clients receive `FHIR_ALL_READ`, `FHIR_ALL_WRITE`, `FHIR_TRANSACTION`, and `FHIR_ACCESS_PARTITION_NAME: <TENANT>` without `DEFAULT` in the argument list. Write isolation then follows from partition access: the session cannot write to `DEFAULT` because it cannot access `DEFAULT` at all while authenticated. Shared data remains available to the same application through anonymous reads of `DEFAULT`, and conformance and terminology resources (StructureDefinition, ValueSet, CodeSystem, SearchParameter, IG packages) are non-partitionable in HAPI FHIR, always live in the default partition, and are served to every tenant automatically.
4. **Rollout is staged one node at a time**: rehearsal and first real tenants on `ereq`, then `aucore`. See `docs/multitenancy-rollout-plan.md`.
5. **Partition definitions move to a git-tracked seed file** (`partitioning.seed.file`) once the tenant list stabilises. Initial tenants are created through the admin API to avoid pod restarts during events.
6. **A consent-service script is explicitly deferred.** If a future requirement demands a single authenticated session with read access to `DEFAULT` and write access to a tenant, the documented fallback is a small JavaScript consent service on the FHIR endpoint that rejects write verbs when the request tenant is `DEFAULT`. It is not part of this decision.

## Alternatives considered

- **Status quo (shared DEFAULT, per-user write grants).** Rejected: write access for one participant endangers the curated data for all, and custom test data cannot coexist cleanly.
- **Consent-script-enforced read-only DEFAULT with mixed grants.** Workable and documented (Smile CDR Consent Service), but adds custom code where pure configuration suffices. Kept as the fallback for mixed-session requirements.
- **Separate Smile CDR instance or node per vendor.** Strong isolation but multiplies infrastructure cost, IG deployment effort, and operational surface. Partitions provide the needed isolation on existing infrastructure.
- **REQUEST_HEADER partition selection.** Supports multi-partition reads but is flagged early-access by Smile, and changing selection mode is a disruptive reconfiguration. URL-based REQUEST_TENANT is the mainline supported path and is already live.

## Consequences

Positive:

- Vendors and scenarios get genuine read/write sandboxes; the shared dataset becomes tamper-proof for non-admins.
- Tenant lifecycle (create, clear, delete) is a runtime admin operation with no restarts and no effect on other tenants.
- Per-tenant data clearing replaces all-or-nothing expunges between events.

Constraints accepted (verified against Smile CDR and HAPI FHIR documentation):

- **One global resource-ID pool.** Client-assigned IDs are unique across the whole server, not per partition. Tenants loading standard test bundles with fixed IDs can collide with `DEFAULT` or each other. Mitigation: tenant data loads use server-assigned IDs or tenant-prefixed IDs; behaviour is verified in the Phase 0 test matrix.
- **Cross-partition references are blocked** (`cross_partition_reference_mode: NOT_ALLOWED`, the default). Tenant data must be self-contained; a tenant cannot reference the shared patients in `DEFAULT` by local reference. This is the correct isolation posture and matches the "load your own data" use case.
- **No cross-tenant search.** URL-based mode has no all-partitions query (`_ALL` is supported only for `$reindex`). Administrative sweeps iterate per tenant.
- **Subscriptions match only within their own partition** by default. Scenario subscriptions are created inside the scenario tenant.
- **Existing scripts hardcode DEFAULT** (`scripts/register_smart_client.py`, `scripts/manage_smart_users.py`, `module-config/smart-post-authorize.js`). They gain a tenant parameter as part of the rollout.
- Users granted only a vendor tenant lose authenticated access to `DEFAULT`; they read shared data anonymously instead. This is a deliberate simplification.

Risks:

- A historical HAPI FHIR defect (hapifhir/hapi-fhir#3396) allowed a write in one partition to overwrite a same-ID resource in another; a fix was merged but the exact fixed release is unconfirmed. The Phase 0 matrix tests this exact case on our version before any tenant is handed to a vendor.
- The conditional-operation match-URL cache historically ignored partition ID (hapifhir/hapi-fhir#6767, fixed in HAPI FHIR 8.0/2025 timeframe). `match_url_cache.enabled: true` is set on `aucore`. The Phase 0 matrix tests conditional isolation; if it fails, the cache is disabled on partitioned nodes.
- Smile CDR has no formal statement on some edge behaviours (for example anonymous users holding partition permissions). Phase 0 verifies empirically; a Smile support ticket is the escalation path for surprises.

## References

- Smile CDR: Partitioning and Multitenancy, https://smilecdr.com/docs/fhir_repository/partitioning.html
- Smile CDR: FHIR Storage Partitioning configuration, https://smilecdr.com/docs/configuration_categories/fhir_storage_partitioning.html
- Smile CDR: FHIR Endpoint Partitioning configuration, https://smilecdr.com/docs/configuration_categories/fhir_endpoint_partitioning.html
- Smile CDR: Roles and Permissions, https://smilecdr.com/docs/security/roles_and_permissions.html
- Smile CDR: Consent Service, https://smilecdr.com/docs/security/consent_service.html
- HAPI FHIR: Partitioning, https://hapifhir.io/hapi-fhir/docs/server_jpa_partitioning/partitioning.html
- Related documents: `docs/multitenancy-strategy.md`, `docs/multitenancy-rollout-plan.md`
