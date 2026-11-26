# SMART Auth Configuration

How SMART on FHIR authentication is configured on the Smile CDR node,
where the configuration actually lives at runtime, and how to keep the repo
and the servers in sync.

## Architecture

`aucore` is the only node; `ereq` and `hl7au` were decommissioned on
2026-08-03. The node runs its own set of modules:

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
- **Client registration**: a GitHub issue from template 05 is registered by
  the `register-smart-client` job in `.github/workflows/issue-labeled.yml`
  once an admin applies the `ready-for-automation` label; it runs
  `scripts/register_smart_client.py` against the Admin JSON API. Tenant
  partitions and login users are not created by that job: an admin creates
  them by hand (see [fhirfrog-tenant.md](fhirfrog-tenant.md) and
  `scripts/manage_smart_users.py`). `.github/workflows/register-smart-clients.yml`
  is a separate manual dispatch for bulk or single registrations, and
  `module-config/connectathon-clients.json` holds the bulk connectathon set.
  Both workflows call the API at its in-cluster Service address
  (`SMILECDR_ADMIN_URL`), so they run on `arc-runner-smile-admin`, the scale
  set reserved for the registration jobs. A run from a workstation uses the
  public admin route, which the gateway allowlists by client address (CSIRO
  network or VPN).
- **Users**: `scripts/manage_smart_users.py` creates users in
  `local_security` (definitions in `module-config/connectathon-users.json`).
- **Anonymous access**: deliberately enabled for the public sandbox. The
  `ANONYMOUS` user has `FHIR_ALL_READ` restricted to the `DEFAULT` partition,
  so tenant partitions are only reachable with credentials scoped to them.

## Where config lives: the drift model

The sparkey deployment runs the node in `PROPERTIES_UNLOCKED` mode:
`module-config/values-sparkey.yaml` sets `config.database: false` and
`config.troubleshooting: true` for `aucore`, overriding the
`config.database: true` inherited from `simplified-multinode.yaml`. That means:

1. The Helm-rendered properties (from the ConfigMap the last `terraform apply`
   produced) are **authoritative** and are re-read on **every** boot,
   overwriting the module config in the database.
2. The admin console stays usable for live troubleshooting, but module config
   edits made through the console or the Admin JSON API are **lost on the next
   pod restart**. Records stored in the database, such as OIDC clients, users
   and partitions, are not module config and do persist.
3. A change merged to this repo reaches the node only through a local
   `terraform apply`, which updates the Helm release and rolls the pod.

So anything that must persist belongs in `module-config/`, deployed by an
apply. The earlier model, in which the database was authoritative and the
properties seeded only the first boot, applied to the decommissioned
`sparked-smilecdr` deployment.

`scripts/sync_smart_auth.py` was written for that earlier model. Under
`PROPERTIES_UNLOCKED` its changes do not survive a restart (measured
2026-08-03; see the `smart_auth` comments in `simplified-multinode.yaml`), so
it is now useful only to show drift or to test a change live before it goes
into the config:

```bash
# See drift (dry-run is the default)
python scripts/sync_smart_auth.py

# Apply canonical config (restarts smart_auth on the node)
python scripts/sync_smart_auth.py --apply
```

The script manages these `smart_auth` options on `aucore`:
the post-authorize script text (rendered per node so the fallback audience
points at the node's own FHIR base), the auth request parameter whitelist,
the signing keystore, CORS, and `smart_capabilities_list` (which is
multi-line; it is now seeded from `simplified-multinode.yaml` with escaped
newlines, so the config is its source of truth).

After changing `smart-post-authorize.js` or a `smart_auth` value, deploy it
with a `terraform apply`. Running the sync script with `--apply` restarts the
module, briefly interrupting token issuance, and the change still lasts only
until the next pod restart.

## hl7au was excluded (historical)

The `hl7au` node was decommissioned on 2026-08-03. While it ran, its live
`smart_auth` predated the per-node layout: it listens at the
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
   python scripts/manage_smart_users.py \
     --node aucore --tenant "PLATYPUS,DEFAULT" \
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
   `DEFAULT`, exempting curator accounts. It is wired on the **FHIR REST
   Endpoint** module, not persistence, via `consent_service.enabled` and
   `consent_service.script.file`; see
   [consent-service-rollout.md](consent-service-rollout.md) for why, for the
   observe-then-enforce procedure, and for the rollback.

   **It is enforcing on `aucore` since 2026-08-19** (`ENFORCE = true`): writes
   to `DEFAULT` from non-curator principals are rejected with a 403. It shipped
   in observe mode first. A `<TENANT>,DEFAULT` grant such as
   `platypus-demo-patient`'s (`read-write` on `PLATYPUS,DEFAULT`) therefore
   reads `DEFAULT` but cannot write it. If the consent service is ever set back
   to observe mode or disabled, a `<TENANT>,DEFAULT` grant again confers
   `DEFAULT` write.

## Known follow-ups

- **Asymmetric client authentication** (`private_key_jwt`, SMART capability
  `client-confidential-asymmetric`): the modern best practice for SMART
  Backend Services and the direction AU eRequesting is heading. Requires
  registering clients with a JWKS (URL or inline) and advertising the
  capability; `register_smart_client.py` would need a `--jwks-url` option.
- **SMART v2 granular scopes** (`permission-v2`): not currently advertised;
  connectathon clients use v1 scopes.
- **Locked config**: done on the sparkey deployment, which runs
  `PROPERTIES_UNLOCKED` (properties authoritative, console still usable but
  reverted on restart). The fully locked `PROPERTIES` mode would also remove
  the console as an escape hatch; not planned.
