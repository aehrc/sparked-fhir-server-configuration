# ADR 0001: Partition-based multitenancy with a read-only DEFAULT tenant

- **Status**: Proposed (requires DTR and Brett Esler sign-off per repository governance)
- **Date**: 2026-07-13
- **Deciders**: DTR, Brett Esler
- **Technical scope**: Sparked Dev FHIR Server (`smile.sparked-fhir.com`), nodes `ereq` and `aucore`. The `hl7au` node is explicitly out of scope for this ADR.

**Revision 2026-07-16.** Decision points 2, 3, and 6 are revised: **authenticated
tenant sessions may read `DEFAULT`, exactly as anonymous clients already can**;
`DEFAULT` stays write-protected for participant principals, now enforced by the
consent service that was previously deferred (point 6). The original "vendor
sessions lose authenticated `DEFAULT` access and read it anonymously instead"
simplification is withdrawn. Trigger: a partition-scoped SMART app cannot write a
resource that references a conformance resource without also reading it — e.g. a
patient app returning a `QuestionnaireResponse` (which references its
`Questionnaire`) got a hard `403 "User does not have access to Questionnaire
resources on the requested partition"`, because `Questionnaire` and the other
definitional/conformance types are non-partitionable and live in `DEFAULT`, which
the authenticated tenant session could not see. See
[docs/smart-auth-config.md](../smart-auth-config.md#authenticated-default-reads).

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
2. **DEFAULT is read-only for participant principals, and readable by everyone.** The curated shared dataset stays in `DEFAULT`. Both anonymous clients **and authenticated tenant sessions** may read it; no session may write it except the team curator accounts. Because Smile CDR's `FHIR_ACCESS_PARTITION_NAME` gates read and write together and there is no partition-scoped read-only permission, the write protection is enforced by the consent service in point 6 (it rejects write verbs whose request partition is `DEFAULT`), not by withholding partition access. Team-internal accounts (`ADMIN`, `DevTester`, `placer`, `filler`) are exempt from that rejection and retain read/write on the nodes they exist on: they are operated by the Sparked team and are the mechanism for curating the shared dataset (test data loads, IG seeding checks, placer/filler reference flows).
3. **Vendor principals are scoped to their tenant plus `DEFAULT` (read).** A vendor's users and OIDC clients receive `FHIR_ALL_READ`, `FHIR_ALL_WRITE`, `FHIR_TRANSACTION`, and `FHIR_ACCESS_PARTITION_NAME: <TENANT>,DEFAULT`. Write isolation for `DEFAULT` comes from the consent service (point 6), not from absence of partition access; writes to `<TENANT>` are unaffected. Including `DEFAULT` in partition access is what lets an authenticated session read the shared curated data **and** the non-partitionable conformance/terminology resources (`StructureDefinition`, `ValueSet`, `CodeSystem`, `SearchParameter`, `Questionnaire`, IG packages) that HAPI FHIR always stores in the default partition. Those resources are required not only for validation but for ordinary authenticated operations that reference them — for example creating a `QuestionnaireResponse`, whose `questionnaire` reference the server resolves against `Questionnaire` in `DEFAULT`.
4. **Rollout is staged one node at a time**: rehearsal and first real tenants on `ereq`, then `aucore`. See `docs/multitenancy-rollout-plan.md`.
5. **Partition definitions move to a git-tracked seed file** (`partitioning.seed.file`) once the tenant list stabilises. Initial tenants are created through the admin API to avoid pod restarts during events.
6. **A consent-service script enforces the read-only `DEFAULT`** (adopted; previously deferred). A small JavaScript consent service on each partitioned FHIR endpoint rejects write verbs (`CREATE`/`UPDATE`/`DELETE`/`PATCH` and write entries in a `transaction`) whose resolved request partition is `DEFAULT`, and otherwise proceeds. Curator accounts are exempt (identified by a superuser role / an explicit curator authority) so shared-data maintenance is unaffected. Reads of `DEFAULT` always proceed. This is the mechanism that makes points 2 and 3 hold, given the coarse partition permission. A reference implementation is at [`module-config/consent-default-readonly.js`](../../module-config/consent-default-readonly.js); wiring it into a node's persistence module (`consent_service.script.file`) and re-running the Phase 0 matrix with a DEFAULT-write-rejection case is a rollout step, gated on the same sign-off and rehearsal as the rest of the rollout.

## Alternatives considered

- **Status quo (shared DEFAULT, per-user write grants).** Rejected: write access for one participant endangers the curated data for all, and custom test data cannot coexist cleanly.
- **Consent-script-enforced read-only DEFAULT with mixed grants.** Originally kept only as a deferred fallback (config alone was preferred). **Adopted in the 2026-07-16 revision** (point 6): pure partition config cannot express "authenticated read of `DEFAULT`, no write", which real authenticated workflows need (conformance-referencing writes), so the small consent script is warranted.
- **Separate Smile CDR instance or node per vendor.** Strong isolation but multiplies infrastructure cost, IG deployment effort, and operational surface. Partitions provide the needed isolation on existing infrastructure.
- **REQUEST_HEADER partition selection.** Supports multi-partition reads but is flagged early-access by Smile, and changing selection mode is a disruptive reconfiguration. URL-based REQUEST_TENANT is the mainline supported path and is already live.

## Consequences

Positive:

- Vendors and scenarios get genuine read/write sandboxes; the shared dataset becomes tamper-proof for participants (only team-operated accounts can modify it).
- Tenant lifecycle (create, clear, delete) is a runtime admin operation with no restarts and no effect on other tenants.
- Per-tenant data clearing replaces all-or-nothing expunges between events.

Constraints accepted (verified against Smile CDR and HAPI FHIR documentation):

- **One global resource-ID pool.** Client-assigned IDs are unique across the whole server, not per partition. Tenants loading standard test bundles with fixed IDs can collide with `DEFAULT` or each other. Mitigation: tenant data loads use server-assigned IDs or tenant-prefixed IDs; behaviour is verified in the Phase 0 test matrix.
- **Cross-partition references are blocked** (`cross_partition_reference_mode: NOT_ALLOWED`, the default). Tenant data must be self-contained; a tenant cannot reference the shared patients in `DEFAULT` by local reference. This is the correct isolation posture and matches the "load your own data" use case.
- **No cross-tenant search.** URL-based mode has no all-partitions query (`_ALL` is supported only for `$reindex`). Administrative sweeps iterate per tenant.
- **Subscriptions match only within their own partition** by default. Scenario subscriptions are created inside the scenario tenant.
- **Existing scripts hardcode DEFAULT** (`scripts/register_smart_client.py`, `scripts/manage_smart_users.py`, `module-config/smart-post-authorize.js`). They gain a tenant parameter as part of the rollout; tenant principals are seeded with `<TENANT>,DEFAULT` partition access so the authenticated `DEFAULT` read holds.
- Authenticated tenant sessions can read `DEFAULT` (curated shared data and conformance resources) as well as their own tenant, matching anonymous read access; the read-only guarantee for `DEFAULT` is upheld by the consent service rather than by partition isolation. The write-rejection path is a new correctness-critical surface: it must exempt curator accounts and must catch write entries inside `transaction` bundles, both covered by the Phase 0 matrix before deploy.
- **Interim state (2026-07-16):** ahead of the consent service being wired and deployed, the `platypus-demo-patient` user on `ereq` was granted `FHIR_ACCESS_PARTITION_NAME: DEFAULT` directly (coarse — currently also permits `DEFAULT` writes) so SDC form-return writeback could be demonstrated. This is a demo-only stopgap to be normalised once the consent service lands (the grant stays; the write exposure is then closed centrally).

Risks (both historical defects were tested empirically in Phase 0 on 2026-07-13 and neither reproduces on 2025.11.R02; see the rollout plan's results table):

- A historical HAPI FHIR defect (hapifhir/hapi-fhir#3396) allowed a write in one partition to overwrite a same-ID resource in another. **Verified fixed on our version**: the colliding write is rejected with HTTP 409 and the original resource is untouched.
- The conditional-operation match-URL cache historically ignored partition ID (hapifhir/hapi-fhir#6767). `match_url_cache.enabled: true` is set on `aucore`. **Verified isolated on our version**: a conditional update in one partition does not match an identifier that exists only in another.
- Smile CDR has no formal statement on some edge behaviours (for example anonymous users holding partition permissions). Phase 0 verified the core access model empirically; a Smile support ticket is the escalation path for future surprises.

## Verification

The full access model was demonstrated live on the `ereq` node on 2026-07-13 with `scripts/multitenancy_phase0_tests.sh`: runtime tenant creation, anonymous denial on the new tenant, tenant-scoped read/write for a scoped user with hard 403s against DEFAULT, cross-partition reference blocking, ID-collision rejection without overwrite, conditional-update isolation, and clean teardown. Results are recorded in `docs/multitenancy-rollout-plan.md`.

## References

- Smile CDR: Partitioning and Multitenancy, https://smilecdr.com/docs/fhir_repository/partitioning.html
- Smile CDR: FHIR Storage Partitioning configuration, https://smilecdr.com/docs/configuration_categories/fhir_storage_partitioning.html
- Smile CDR: FHIR Endpoint Partitioning configuration, https://smilecdr.com/docs/configuration_categories/fhir_endpoint_partitioning.html
- Smile CDR: Roles and Permissions, https://smilecdr.com/docs/security/roles_and_permissions.html
- Smile CDR: Consent Service, https://smilecdr.com/docs/security/consent_service.html
- HAPI FHIR: Partitioning, https://hapifhir.io/hapi-fhir/docs/server_jpa_partitioning/partitioning.html
- Related documents: `docs/multitenancy-strategy.md`, `docs/multitenancy-rollout-plan.md`
