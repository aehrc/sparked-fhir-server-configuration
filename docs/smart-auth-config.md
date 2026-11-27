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
  When neither the launch value's `practitioner` key nor a `practitioner`
  default context names fhirUser, a sandbox login's default context of
  type `sbx-fhiruser` (written by aehrc/sparked-sandbox, for example
  `Patient/<sandbox id>-<patient>` when the deployment names a Patient as
  fhirUser) sets it, if its resource id is `Patient/<id>` or
  `Practitioner/<id>`; other users have no such context and are unchanged.
  Each launch value (other than `practitioner`) always becomes a launch
  resource id. Smile CDR then adds the matching access token claim itself,
  once for each approved scope that covers it: `launch` covers every launch
  resource id and `launch/<key>` its own. With both approved it adds the
  claim twice, and its own second add throws `IllegalArgumentException` in
  `SmartTokenEnhancerSvcImpl.validateDontAlreadyHaveClaim` (called from
  `addLaunchScopes`), so an EHR launch asking for `launch launch/patient`
  (or `launch launch/encounter`) failed with HTTP 500 on every client, with
  or without a default `patient` context on the user. Measured on `aucore`
  2026-11-27 and reproduced the same day on local Smile CDR 2026.05.R01 and
  2026.11.R01, also with a script that only calls `addLaunchResourceId`; no
  release note up to 2026.11.R01 mentions it. So on an EHR launch, when both
  `launch` and `launch/<key>` are approved, the script drops `launch/<key>`
  with the documented `theUserSession.removeApprovedScope` and logs one
  `INFO` line naming the dropped scope. Smile CDR then adds the claim once:
  the token carries the launch's context, refreshes keep it, and its
  `scope` omits `launch/<key>` (SMART App Launch lets the granted scopes
  differ from those requested). A client that remembers approvals shows no
  new consent screen on the next login (measured). Two cases keep the 500:
  an approved scope set the script cannot read (nothing is dropped), and a
  `removeApprovedScope` that throws (a warning is logged). The script also
  adds the claim itself, as it always has, unless `launch/<key>` is
  approved; its own claim does not count towards Smile CDR's check
  (`launch` alone with the script's claim answers 200). Neither scope
  source alone is trusted to equal the grant: the user session's approved
  scopes may carry approvals remembered from an earlier consent, and the
  whitelisted `scope` request parameter may name a scope the user
  declined. So the claim is left to Smile CDR only when `launch/<key>` is
  in the approved scopes and, when the request parameter is readable, in
  it as well; when the approved scopes are unreadable the request
  parameter decides alone, and when neither can be read the claim is added
  as before. Smile CDR 2026.05.R01
  runs the script on a sandboxed GraalVM that hands it Java objects, and
  its host access policy may expose only the documented callback methods
  (`getOrCreateDefaultLaunchContext`, `addLaunchResourceId`,
  `addAccessTokenClaim` and `getLaunch()` work on `aucore`), refusing the
  generic Java methods of a Set or List. So every read tries several
  shapes, each on its own, and never throws. The approved scopes (a
  `java.util.Set<String>`) are read once per callback, trying in order
  `contains()` on `theUserSession.getApprovedScopes()` and then on
  `theUserSession.approvedScopes`, then `for (... of ...)` over each, then
  each one's string form `[a, b, c]` parsed; a JS array or string never
  counts, and an empty set counts as unknown. The requested scopes are
  read with `theAuthorizationRequestDetails.getRequestParameters().get("scope")`
  (a `java.util.Map<String,String>` filtered by
  `auth_request_detail.whitelist`), converted with `String(...)` and split
  on whitespace; a read that throws makes that source unknown. Launch
  contexts are read by type with the documented
  `theUserSession.getOrCreateDefaultLaunchContext(type)`, taking
  `ctx.resourceId` and then `ctx.getResourceId()`: `practitioner` and then
  `sbx-fhiruser` for `fhirUser`, `patient` and then `sbx-patient-2` to
  `sbx-patient-9` for the chooser, skipping a missing or empty one. The
  `defaultLaunchContexts` list is the second fallback for every type but
  `practitioner`; when reading it throws, a warning is logged and it counts
  as empty. The first version (#132) read the scopes as JS arrays and
  strings and the contexts from the list; on the real engine the 500
  persisted and the chooser never showed after it rolled out (measured on
  `aucore` 2026-11-27), while its node tests passed. For clients whose id
  starts with `sbx-` only, the script logs one `INFO` line per callback
  (token generation, context selection), starting `Sandbox scopes at`,
  naming which approved-scope method worked with its size and values, the
  method that read each context type found, the requested scope string
  (not available at context selection), the flow and, at context
  selection, the number of patient choices; it holds scope names and
  context types only, never a token, code, password, launch value or
  resource id. The same script also offers a **patient picker for sandbox
  logins**: `onSmartLoginPreContextSelection` adds one person per sandbox
  patient on the user, so Smile CDR shows its context selection screen and
  puts the chosen patient's resource id into the launch context. Smile CDR
  stores at most one default launch context per context type per user (a
  user PUT with three `patient` contexts failed with HTTP 500 on the unique
  constraint `idx_userdeflnchctx_user_ctyp`, measured on `aucore`
  2026-11-27), but it accepts and returns context types of its users' own
  choosing unchanged. So the sandbox's default patient is the `patient`
  context and each further starter patient is a context of type
  `sbx-patient-<n>` (`sbx-patient-2`, `sbx-patient-3`, ...). The choices are
  the `patient` context first, then the `sbx-patient-<n>` contexts in
  ascending order of `<n>` (2 to 9 read by type, any further one only from
  the list), skipping empty and repeated resource ids, each offered
  exactly as stored. It
  acts only for clients whose id starts with `sbx-` (registered by
  aehrc/sparked-sandbox, which writes those contexts), only on a standalone
  launch granted `launch/patient` without `launch` (read the same
  way; unknown offers no chooser), and only when that gives
  two or more choices. It never changes authorities or scopes, and any
  error is logged and swallowed, so no other client on `aucore` is
  affected. Each person's patient id is written before its names, so a
  failure partway through adding never leaves a named person without a
  patient id; the persons already added stay (Smile CDR has no call to
  remove one), and a failure on the patient id write itself can leave one
  empty person. The picker does not offer anything yet: Smile CDR calls
  `onSmartLoginPreContextSelection` on every interactive login, right after
  sign-in and before consent, with `oidcClientId` null and the approved
  scopes empty (measured on local Smile CDR 2026.05.R01 and 2026.11.R01,
  2026-11-27), so its client and scope checks never pass; the
  context-selection choices expose no requested scopes either, so a script
  cannot tell an EHR launch from a standalone one there. With the checks
  bypassed, Smile CDR showed its selection screen and the chosen patient
  became the token's `patient`. `node scripts/test_smart_post_authorize.js`
  unit tests both (CI runs it in `validate-config.yml`).
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
  public admin route, which the gateway allowlists by client address (the
  CSIRO VPN pools; a CSIRO site without the VPN is not on the list).
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

1. The Helm-rendered properties (from the ConfigMap the last sync of the Argo
   CD Application `smilecdr` produced) are **authoritative** and are re-read
   on **every** boot, overwriting the module config in the database.
2. The admin console stays usable for live troubleshooting, but module config
   edits made through the console or the Admin JSON API are **lost on the next
   pod restart**. Records stored in the database, such as OIDC clients, users
   and partitions, are not module config and do persist.
3. A change merged to this repo reaches the node through the Argo CD
   Application `smilecdr`, which syncs automatically: within about two minutes
   of the merge it renders the new config and rolls the pod
   ([sparkey-deploy-runbook.md](sparkey-deploy-runbook.md), section A).

So anything that must persist belongs in `module-config/`, deployed by a
merge. The earlier model, in which the database was authoritative and the
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
with a PR; merging it is the deploy
([sparkey-deploy-runbook.md](sparkey-deploy-runbook.md), section A; for the
script, run `scripts/render_smile_mapped_files.py` first). Running the sync
script with `--apply` restarts the
module, briefly interrupting token issuance, and the change still lasts only
until the next pod restart.

Live check after a change to `smart-post-authorize.js` reaches the node (the
merge rolls the pod), from the CSIRO VPN against a test sandbox, before either
sandbox launch flag is switched on:

- On one non-sandbox client and user (such clients remember approvals): an
  EHR launch asking for `launch launch/patient` first, then one asking for
  `launch` alone; both tokens carry `patient`, and the first token's
  `scope` lists `launch` without `launch/patient`.
- An EHR launch asking for `launch` alone still returns `patient` in the
  token response and in the access token.
- An EHR launch asking for `launch launch/patient` returns 200 and a token
  carrying `patient` (was HTTP 500), and the pod log shows `EHR launch:
  dropped approved scope launch/patient` for it.
- A non-sandbox client's standalone login is unchanged: no chooser, and the
  same patient as before.
- A sandbox standalone launch asking for `launch/patient` without `launch`
  shows the chooser, and the chosen patient is the token's bare `patient`.
- A sandbox login with an `sbx-fhiruser` context of `Patient/...` gets that
  Patient as `fhirUser` on a standalone launch.
- Client credentials are unchanged.
- A sandbox EHR launch asking for `launch/encounter`, with no encounter in
  the launch value, gets a token; with an encounter in the launch value, the
  token carries `encounter` (was HTTP 500).
- The pod log shows one `Sandbox scopes at` line per sandbox callback
  above and none for the non-sandbox ones. Read it for each check: it
  names the approved-scope method that worked on this build (for example
  `approved read=String(getApprovedScopes())`) with the size and values it
  returned, the method that read each context type found, and the number of
  patient choices. `approved read=none (...)` lists why each method failed;
  `contexts=none` on a chooser login means no context was read by type or
  from the list.

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
   <Type> resources on the requested partition"` for those types, which breaks
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
