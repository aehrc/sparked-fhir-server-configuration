# The FHIRFROG tenant on `aucore`

FHIRFrog (`aehrc/fhir-frog`, module `frog-runner`) is an automated FHIR
conformance test runner. It executes AU Core `TestScript` bundles end to end,
which means creating fixture resources before each test and deleting them
afterwards. That write requirement is what this tenant exists to serve.

| Partition | What frog-runner uses it for | Writable by `frog-runner` |
| --- | --- | --- |
| `FHIRFROG` (partition 2) | Everything: fixture create, test writes, autodelete teardown | Yes |
| `DEFAULT` | The curated AU Core dataset and shared conformance resources, read **anonymously** | No, and not reachable with the token either |

Requested in [#95](https://github.com/aehrc/sparked-fhir-server-configuration/issues/95).

## What is seeded from this repository, and what is not

Seeded from here:

- `module-config/fhirfrog-clients.json`: the `frog-runner` Backend Service client.

```bash
python scripts/register_smart_client.py --bulk \
  --clients-file module-config/fhirfrog-clients.json --node aucore \
  --secret-file ./frog-runner-secret.txt
```

The run is idempotent: an existing client is skipped rather than overwritten.

**Not seeded from here:**

- **The `FHIRFROG` partition itself.** It was created through the admin API, like
  every other partition on this server. Partition creation is not expressed in
  this repository for any tenant, so making an exception for one would mislead.

  ```bash
  curl -X POST "$BASE/aucore/fhir/DEFAULT/\$partition-management-create-partition" \
    -H "Authorization: Basic $CSIRO_FHIR_AUTH_64" \
    -H "Content-Type: application/fhir+json" \
    -d '{"resourceType":"Parameters","parameter":[
          {"name":"id","valueInteger":2},
          {"name":"name","valueCode":"FHIRFROG"},
          {"name":"description","valueString":"FHIRFrog conformance test runner tenant"}]}'
  ```

- **Test data.** The tenant is empty at rest by design; frog-runner creates and
  deletes its own fixtures per run.

## Why this client has no `DEFAULT` grant, unlike `platypus-demo-patient`

`frog-runner` carries `FHIR_ACCESS_PARTITION_NAME FHIRFROG`, the tenant alone,
**not** `FHIRFROG,DEFAULT`. That is a deliberate departure from the pattern in
[`platypus-demo-tenant.md`](platypus-demo-tenant.md) and from ADR 0001 point 3,
and the reason is that the mechanism those rely on is not deployed.

ADR 0001 grants tenant principals `<TENANT>,DEFAULT` and makes `DEFAULT`
read-only through a consent service (point 6) that rejects write verbs whose
request partition is `DEFAULT`. Smile CDR's `FHIR_ACCESS_PARTITION_NAME` gates
reads and writes together, so the consent service is the *only* thing standing
between a `DEFAULT` grant and `DEFAULT` write.

**That consent service is not wired on any node.** `module-config/consent-default-readonly.js`
exists as a reference implementation, and no module sets `consent_service.script.file`.
What actually protects `DEFAULT` on `aucore` today is that participant principals
do not hold `FHIR_ALL_WRITE` at all: Phase 2 stripped it from
`connectathon-backend-02` and several users on 2026-07-15 (see
`multitenancy-rollout-plan.md`).

`frog-runner` needs `FHIR_ALL_WRITE` to do its job. Granting it `DEFAULT`
partition access as well would hand a fully automated test runner, one whose
normal operation includes bulk `autodelete` teardown, write and delete authority
over the curated AU Core dataset that every other participant reads. A single
misconfigured base URL in the runner would be enough. The tenant-only grant
removes that failure mode structurally rather than trusting configuration.

The cost is that the authenticated session gets a hard 403 on `DEFAULT`, so it
cannot read the curated data or the non-partitionable conformance resources
(`StructureDefinition`, `ValueSet`, `CodeSystem`, `SearchParameter`) with its
token. In practice that is not a blocker, because **`DEFAULT` is readable
anonymously**: a client that needs the curated dataset or a profile simply reads
it without an `Authorization` header, and uses the token only for tenant writes.

If a workflow ever genuinely needs an authenticated `DEFAULT` read here, the fix
is to wire the consent service and then widen the grant to `FHIRFROG,DEFAULT`,
in that order. Widening first re-creates exactly the exposure Phase 2 closed.

## Known limits of a fresh tenant

These follow from ADR 0001 and apply to any new tenant, but they bite a test
runner in particular:

- **The tenant starts empty.** It holds no copy of the AU Core dataset. Fixtures
  must be created by the runner, which is what frog-runner already does.
- **Cross-partition references are blocked** (`cross_partition_reference_mode: NOT_ALLOWED`).
  Fixture bundles must be self-contained; a resource in `FHIRFROG` cannot
  reference a `Patient` in `DEFAULT` by local reference.
- **Resource IDs are one global pool.** Client-assigned IDs are unique across the
  whole server, not per partition, so a fixture bundle with fixed IDs can collide
  with `DEFAULT` and be rejected with a 409. Server-assigned or tenant-prefixed
  IDs avoid this. `aucore` runs `client_id_mode: ANY`, which is why a
  cross-partition reference surfaces as a 409 rather than a 400 here.
- **No cross-tenant search.** URL-based tenant identification has no
  all-partitions query.

## Credentials

`frog-runner` is a confidential client using the Client Credentials grant.

```bash
curl -X POST https://smile.sparked-fhir.com/aucore/smartauth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=frog-runner&client_secret=<SECRET>"
```

The FHIR base is `https://smile.sparked-fhir.com/aucore/fhir/FHIRFROG`.

The secret is **not** stored in this repository. Note that
`register_smart_client.py` stores it hashed server-side and cannot read it back:
if it is lost, it has to be reset with a `PUT` to the client's admin JSON record,
not recovered. Use `--secret-file` at registration time to capture it.
