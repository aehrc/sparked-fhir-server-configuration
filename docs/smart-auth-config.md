# SMART Auth Configuration

How SMART on FHIR authentication is configured across the Smile CDR nodes,
where the configuration actually lives at runtime, and how to keep the repo
and the servers in sync.

## Architecture

Each node (`aucore`, `ereq`, `hl7au`) runs its own set of modules:

| Module | Type | Role |
|---|---|---|
| `smart_auth` | `SECURITY_OUT_SMART` | OAuth2/OIDC authorization server at `/<node>/smartauth` |
| `local_security` | `SECURITY_IN_LOCAL` | User store backing OAuth logins and HTTP basic auth |
| `fhir_endpoint` | `ENDPOINT_FHIR_REST` | FHIR API; validates bearer tokens via `security.oic.enabled` |

Supporting pieces:

- **Token signing**: `openid.signing.keystore_id = smilecdr-token-signing`
  (a dedicated keystore, not the built-in `default-keystore`).
- **Launch context**: `module-config/smart-post-authorize.js` runs at token
  issuance. It injects patient/encounter context from EHR launch tokens and
  sets `fhirUser` to the correct Practitioner (Smile CDR otherwise invents a
  RelatedPerson). Backend service (client credentials) flows are skipped.
- **Client registration**: GitHub issue template 05 feeds
  `.github/workflows/register-smart-clients.yml`, which runs
  `scripts/register_smart_client.py` against the Admin JSON API. Client
  definitions live in `module-config/connectathon-clients.json`.
- **Users**: `scripts/manage_smart_users.py` creates users in
  `local_security` (definitions in `module-config/connectathon-users.json`).
- **Anonymous access**: deliberately enabled for the public sandbox. The
  `ANONYMOUS` user has `FHIR_ALL_READ` restricted to the `DEFAULT` partition,
  so tenant partitions are only reachable with credentials scoped to them.

## Where config lives: the drift model

`simplified-multinode.yaml` sets `config.database: true` for every node, which
means:

1. The Helm-rendered properties are read **once**, on a node's first boot,
   to seed the cluster manager database.
2. From then on, the **database is authoritative**. Admin console edits land
   in the database. Changes to the Helm values or mapped files do NOT reach a
   running node, even across pod restarts.

Consequently the repo drifts from reality unless actively reconciled. That is
what `scripts/sync_smart_auth.py` is for:

```bash
# See drift (dry-run is the default)
python scripts/sync_smart_auth.py

# Apply canonical config (restarts smart_auth on the node)
python scripts/sync_smart_auth.py --apply
```

The script manages these `smart_auth` options on `aucore` and `ereq`:
the post-authorize script text (rendered per node so the fallback audience
points at the node's own FHIR base), the auth request parameter whitelist,
the signing keystore, CORS, and `smart_capabilities_list` (which is
multi-line and therefore cannot be seeded safely through the properties
file; the sync script is its only source of truth).

After changing `smart-post-authorize.js` or the canonical values in the sync
script, run it with `--apply`. Note the module restart briefly interrupts
token issuance on that node.

## hl7au is excluded

`hl7au`'s live `smart_auth` predates the per-node layout: it listens at the
bare `/smartauth` context path with issuer
`https://smile.sparked-fhir.com/smartauth` and the `default-keystore`, and has
no post-authorize script. The repo records the intended per-node state
(`hl7au/smartauth`), but moving the live context path requires coordinated
ingress changes and is out of scope for config reconciliation. Until that
move is planned, `sync_smart_auth.py` does not touch `hl7au`.

## appSphere (app_gallery)

appSphere is Smile CDR's SMART app gallery and developer self-service portal
(module type `APP_GALLERY`). Instances were added via the admin console on
`aucore` and `ereq` but were never wired up:

- No Kubernetes Service or ingress route exists, so
  `/<node>/appsphere` returns 404 at the edge; the module serves nobody.
- The `ereq` instance points at `aucore`'s auth/FHIR/API URLs.
- Approval notification emails, helpdesk contact, and terms/privacy URLs are
  all empty.

Client registration is handled by the GitHub issue workflow instead, which is
auditable and portable. The gallery is redundant with it; archive the unused
modules with:

```bash
python scripts/sync_smart_auth.py --archive-app-gallery --apply
```

If a vendor-facing self-service portal is ever wanted, define the module
per node in `simplified-multinode.yaml` (so the chart creates the Service and
ingress route), point each instance at its own node's URLs, and fill in the
notification and helpdesk fields.

## Authenticated DEFAULT reads

Under [ADR 0001](adr/0001-partition-based-multitenancy.md), the shared `DEFAULT`
partition is readable by everyone (anonymous **and** authenticated tenant
sessions) and writable only by team curator accounts. Two pieces together
deliver that, because Smile CDR's `FHIR_ACCESS_PARTITION_NAME` gates read and
write as one and has no partition-scoped read-only variant:

1. **Grant tenant principals `DEFAULT` alongside their own tenant.** Seed SMART
   users and clients with `FHIR_ACCESS_PARTITION_NAME: <TENANT>,DEFAULT` rather
   than `<TENANT>` alone. With `manage_smart_users.py` pass a comma-separated
   `--tenant`:

   ```bash
   python scripts/manage_smart_users.py create \
     --node ereq --tenant "PLATYPUS,DEFAULT" \
     --username platypus-demo-patient --permissions read-write \
     --patient-id platypus-pat-taylor
   ```

   This is what lets an authenticated session read the curated shared data and
   the non-partitionable conformance/terminology resources (`StructureDefinition`,
   `ValueSet`, `CodeSystem`, `SearchParameter`, `Questionnaire`, IG packages) that
   HAPI FHIR always stores in `DEFAULT`. Without it, an authenticated
   tenant-scoped session gets a hard `403 "User does not have access to
   <Type> resources on the requested partition"` for those types — which breaks
   any authenticated write that references one (e.g. posting a
   `QuestionnaireResponse` whose `questionnaire` the server resolves against
   `Questionnaire`).

2. **Reject `DEFAULT` writes with the consent service.** Granting `DEFAULT`
   partition access also permits writes to it, which ADR 0001 forbids for
   participants. The consent service
   [`module-config/consent-default-readonly.js`](../module-config/consent-default-readonly.js)
   rejects write verbs (and transaction write entries) whose request partition is
   `DEFAULT`, exempting curator accounts. Wire it per node via
   `consent_service.script.file` on the persistence module, and add a
   DEFAULT-write-rejection + curator-exemption case to the Phase 0 matrix before
   deploying. Until it is deployed, treat a `<TENANT>,DEFAULT` grant as also
   conferring `DEFAULT` write (the current interim state for `platypus-demo-patient`
   on `ereq`).

## Known follow-ups

- **Asymmetric client authentication** (`private_key_jwt`, SMART capability
  `client-confidential-asymmetric`): the modern best practice for SMART
  Backend Services and the direction AU eRequesting is heading. Requires
  registering clients with a JWKS (URL or inline) and advertising the
  capability; `register_smart_client.py` would need a `--jwks-url` option.
- **SMART v2 granular scopes** (`permission-v2`): not currently advertised;
  connectathon clients use v1 scopes.
- **Locked config**: switching nodes from database-backed to locked
  (properties-authoritative) config would eliminate drift structurally, but
  is a disruptive migration and removes the admin console as an escape hatch.
  Revisit if drift keeps recurring despite the sync script.
