# Multitenancy rollout plan

Implementation plan for [ADR 0001](adr/0001-partition-based-multitenancy.md). Read the [strategy paper](multitenancy-strategy.md) for the motivation.

**Scope**: nodes `ereq` and `aucore` on the Sparked Dev FHIR Server. The `hl7au` node is untouched by this plan.

**Key property of this rollout**: phases 0 to 2 involve **no config file changes, no pod restarts, and no downtime**. Partitions, users, and permissions are runtime data managed through the admin APIs. The only eventual restart is the optional move to a git-tracked partition seed file in Phase 3.

## Phase 0: rehearsal on ereq (go/no-go gate)

Create a temporary partition `MTTEST` (id 9001) on `ereq`, run the test matrix below with admin credentials plus one throwaway scoped user, then delete everything. A ready-to-run script performs all steps including cleanup.

### Test matrix

| # | Test | Expected | Why it matters |
|---|------|----------|----------------|
| T1 | `$partition-management-list-partitions` | 200, lists DEFAULT | Confirms partition management operations are enabled on our build |
| T2 | Create partition MTTEST via `$partition-management-create-partition` | 200 | Tenant provisioning works at runtime, no restart |
| T3 | Anonymous `GET /MTTEST/Patient` | 401 or 403 | New tenants are private by default; ANONYMOUS only holds DEFAULT access |
| T4 | Admin `PUT /MTTEST/Patient/...` | 201 | Tenant URL routing works end to end |
| T5 | Anonymous `GET /DEFAULT/Patient` still 200; tenant resource invisible via DEFAULT | 200 / 404 | Existing consumers unaffected; no cross-tenant leakage |
| T6 | Same client-assigned ID PUT into MTTEST then DEFAULT | Two independent resources, neither overwritten | Guards against the hapi-fhir #3396 overwrite defect on our version |
| T7 | Observation in MTTEST with local reference to a DEFAULT patient | 4xx rejection | Confirms cross-partition reference blocking (isolation posture) |
| T8 | Conditional PUT in DEFAULT matching an identifier that exists only in MTTEST | 201 create in DEFAULT; MTTEST resource untouched at v1 | Guards against the match-URL-cache defect (hapi-fhir #6767); `match_url_cache` is enabled on aucore |
| T9 | Scoped user (`FHIR_ALL_READ` + `FHIR_ALL_WRITE` + `FHIR_ACCESS_PARTITION_NAME: MTTEST`): read/write MTTEST, read and write DEFAULT | 200/201 in MTTEST; 403 on both DEFAULT calls | Proves the entire access model of ADR 0001 with zero custom code |
| T10 | Cleanup: delete test resources, test user, MTTEST partition | 200s; tenant URL then 4xx | Tenant teardown is clean and total |

**Go/no-go**: T3, T6, T7, T8, and T9 must all behave as expected before any vendor tenant is created. A T6 or T8 failure is a stop: raise with Smile support and re-evaluate (mitigations: server-assigned IDs only, disable the match URL cache).

### Phase 0 results

_To be filled in when the matrix is executed against ereq._

## Phase 1: first real tenants on ereq

1. **Naming convention**: `VENDOR-<NAME>` for vendor sandboxes, `SCENARIO-<TRACK>` for shared scenario workspaces (uppercase, hyphenated, stable). Partition IDs allocated from 100 upwards, recorded in this repo.
2. Create 2 to 3 pilot tenants via `$partition-management-create-partition`.
3. **Script changes** (this repo):
   - `scripts/register_smart_client.py`: replace the `DEFAULT_PARTITION` constant usage with a `--tenant` argument (default `DEFAULT`) so clients can be scoped to a vendor tenant.
   - `scripts/manage_smart_users.py`: same `--tenant` argument; vendor-scoped users get read/write authorities with `FHIR_ACCESS_PARTITION_NAME: <TENANT>` and no `DEFAULT` access.
   - `module-config/smart-post-authorize.js`: derive the FHIR base for `fhirUser` and launch context from the request audience instead of the hardcoded `.../aucore/fhir/DEFAULT` fallback, so tokens minted for tenant endpoints carry tenant-correct URLs.
   - Issue template `05-smart-app-registration.yml`: add a tenant field.
4. **Test data**: tenant loads use server-assigned IDs or tenant-prefixed IDs (single global ID pool). Publish a self-contained starter bundle (patients, practitioners, organizations) that vendors can POST into their tenant, since local references to DEFAULT data are blocked by design.
5. Onboard pilot vendors; their feedback gates Phase 2.

## Phase 2: make DEFAULT read-only on ereq

1. Inventory principals holding `FHIR_ACCESS_PARTITION_NAME: DEFAULT` together with any write permission (`FHIR_ALL_WRITE`, `FHIR_WRITE_ALL_OF_TYPE`, `FHIR_TRANSACTION`). Current known set: `DevTester`, `placer`, `filler` (users.json), read-write connectathon users, and read-write OIDC clients.
2. Remove write authorities from those principals, or re-scope them to a tenant. `ADMIN` (`ROLE_SUPERUSER`) keeps write for curated data loads.
3. Update the seeded `users.json` secret so the read-only shape survives reseeding.
4. Verify: authenticated `POST /DEFAULT/...` returns 403 for every non-admin principal; anonymous and authenticated reads unchanged; test-data loader (admin) still works.
5. Update participant docs (`connectathon-participant-handout.md`, `SMART-APP-REGISTRATION.md`, Confluence entry): DEFAULT is read-only, writes happen in your tenant.

## Phase 3: aucore, then hardening

1. Repeat phases 1 and 2 on `aucore` (aucore also serves AU Core read-only traffic, so DEFAULT read-only is a smaller behavioural change there).
2. Move partition definitions to a git-tracked seed file (`partitioning.seed.file` pointing at a `fhir-partitions.json` in `module-config/`), deployed like package configs. This is the one step that requires a pod roll; schedule it outside events.
3. Add a "Tenant request" offering to the service catalogue (issue template + semi-automated workflow, following the SMART registration pattern).
4. Revisit deferred items: consent-service script for mixed-session access, `subscription.cross_partition_enabled` (currently false; scenario subscriptions live inside their tenant so the default stands), per-tenant bulk export permissions.

## Rollback

- Phases 0 and 1 are purely additive: delete the tenant partitions and vendor principals and the server is bit-identical to today.
- Phase 2 rollback is restoring the previous authorities on the affected principals (they are enumerated in the inventory from step 1 and version-controlled in the users.json secret).
- No step in phases 0 to 2 touches the DEFAULT data, the schema, or module configuration.

## Operational runbook (post-rollout)

| Operation | How |
|---|---|
| Create tenant | `POST {base}/DEFAULT/$partition-management-create-partition` (admin) |
| Grant a client/user a tenant | `FHIR_ACCESS_PARTITION_NAME: <TENANT>` via registration scripts |
| Clear a tenant | Delete/expunge scoped to the tenant URL |
| Delete tenant | Clear it, then `$partition-management-delete-partition` |
| List tenants | `$partition-management-list-partitions` |

## Governance

- ADR 0001 approval (DTR, Brett Esler) is required before Phase 1.
- Phase 0 is a test-only rehearsal on the dev server with full cleanup and may run ahead of approval to inform the ADR evidence section.
- The `hl7au` node and the HL7-hosted reference environments are out of scope; any future extension to them follows the elevated `needs:hl7-approval` process.
