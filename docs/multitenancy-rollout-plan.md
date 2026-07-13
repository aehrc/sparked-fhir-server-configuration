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

Executed 2026-07-13 against `ereq` (Smile CDR 2025.11.R02) using `scripts/multitenancy_phase0_tests.sh`. **All go/no-go tests passed.** Full cleanup verified: tenant URL returns 404 after partition deletion and anonymous DEFAULT reads are unchanged.

| # | Result | Observed |
|---|--------|----------|
| T1 | Note | `$partition-management-list-partitions` returned HTTP 400 on this build; create/delete operations work, so tenant inventory uses the admin console or repo records instead |
| T2 | Pass | Partition created at runtime, HTTP 200, tenant URL live immediately |
| T3 | Pass | Anonymous request to the new tenant rejected with HTTP 403 |
| T4 | Pass | Admin write via tenant URL, HTTP 201 |
| T5 | Pass | Anonymous DEFAULT read unchanged (200); tenant resource invisible via DEFAULT (404) |
| T6 | Pass | Same client-assigned ID in a second partition rejected with HTTP 409 (HAPI-0550/HAPI-0825 client-assigned ID constraint); the first partition's resource untouched at v1. Confirms the global ID pool constraint and confirms the hapi-fhir #3396 cross-partition overwrite defect does not reproduce on 2025.11.R02: the write is safely rejected, nothing is overwritten |
| T7 | Pass | Cross-partition local reference rejected with HTTP 400 (HAPI-1094 target not found in partition) |
| T8 | Pass | Conditional PUT in DEFAULT with an identifier existing only in MTTEST performed a create (201, new resource) rather than a cross-partition update; the MTTEST resource remained readable afterwards. The hapi-fhir #6767 match-URL-cache defect does not reproduce |
| T9 | Pass | Scoped user (write authorities + `FHIR_ACCESS_PARTITION_NAME: MTTEST` only): read and write in MTTEST succeeded (200/201); read and write against DEFAULT both rejected with 403. This is the entire ADR 0001 access model working with zero custom code |
| T10 | Pass | All test resources deleted (200s); partition deleted (200); tenant URL 404 afterwards. One caveat: the user-management API does not support DELETE (405), so the throwaway user was disabled and locked with authorities stripped instead. Vendor offboarding should plan for disable rather than delete |

Consequences folded into this plan: tenant loads must use server-assigned or tenant-prefixed IDs (T6 makes collisions a hard 409, not a corruption risk), and the runbook's "list tenants" row uses the admin console.

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

## Phase 2: make DEFAULT read-only for participants on ereq

Scope decision (2026-07-13): team-internal accounts (`ADMIN`, `DevTester`, `placer`, `filler`) stay read/write on the nodes they exist on; they are the curation mechanism for the shared dataset. Phase 2 applies only to participant principals.

1. Inventory participant principals holding `FHIR_ACCESS_PARTITION_NAME: DEFAULT` together with any write permission (`FHIR_ALL_WRITE`, `FHIR_WRITE_ALL_OF_TYPE`, `FHIR_TRANSACTION`): read-write connectathon users (`connectathon-user-*`) and read-write OIDC clients (`connectathon-app-*`, `connectathon-backend-*`, vendor-registered clients).
2. Remove write authorities from those principals, or re-scope them to a tenant. Record the before state for rollback.
3. The seeded `users.json` secret is unchanged in this phase (it contains only team-internal accounts, which keep their permissions).
4. Verify: authenticated `POST /DEFAULT/...` returns 403 for every participant principal; anonymous and authenticated reads unchanged; team accounts (`ADMIN`, `DevTester`, `placer`, `filler`) and the test-data loader still write.
5. Update participant docs (`connectathon-participant-handout.md`, `SMART-APP-REGISTRATION.md`, Confluence entry): DEFAULT is read-only, writes happen in your tenant.

## Execution log

- **2026-07-13**: Phase 0 executed on ereq, all go/no-go tests passed (results table above).
- **2026-07-13/14**: Phases 1 and 2 executed on ereq with zero pod restarts:
  - Tenants created: `SCENARIO-EREQ-MEDS` (id 100), `VENDOR-DEMO` (id 101).
  - Demo principals created with the new tenant-scoped tooling: `demo-placer`, `demo-filler` (SCENARIO-EREQ-MEDS), `demo-vendor` (VENDOR-DEMO).
  - A validated, self-contained medications scenario (Patient, Practitioner, Organization, MedicationRequest with AMT 23551011000036108, fulfil Task) was loaded by demo-placer and driven to completion by demo-filler, demonstrating the full placer/filler write flow inside a tenant.
  - Participant write removal on ereq DEFAULT: `FHIR_ALL_WRITE` and `FHIR_TRANSACTION` stripped from users `ILYA`, `MICHAEL.OSBORNE`, `PATIENT-DASHBOARD` (before-state snapshots retained). No OIDC client on the ereq node carried write permissions, so no client changes were needed.
  - Deferred: `connectathon-backend-02` holds `FHIR_ALL_WRITE` on DEFAULT but is registered on the **aucore** node; it is handled in Phase 3 with the rest of aucore.
  - See `docs/multitenancy-demo.md` for the verified demo walkthrough.

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
| List tenants | Admin console (Partition Management); the list operation returned 400 on 2025.11.R02 |
| Offboard a principal | Disable and lock the account, strip authorities (user DELETE is unsupported, returns 405) |

## Governance

- ADR 0001 approval (DTR, Brett Esler) is required before Phase 1.
- Phase 0 is a test-only rehearsal on the dev server with full cleanup and may run ahead of approval to inform the ADR evidence section.
- The `hl7au` node and the HL7-hosted reference environments are out of scope; any future extension to them follows the elevated `needs:hl7-approval` process.
