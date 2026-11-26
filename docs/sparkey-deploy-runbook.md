# Smile CDR deploy runbook (steady state, sparkey cluster)

The steady-state deploy runbook for the Sparked Smile CDR server. The `aucore`
node on the shared `sparkey` cluster has served `smile.sparked-fhir.com` since
the cutover on 2026-08-03, and it is the only deployment: the dedicated
`sparked-smilecdr` stack it replaced was destroyed on 2026-08-27 (#89).
[terraform-local-deploy.md](terraform-local-deploy.md) and
[`../terraform/REMEDIATION.md`](../terraform/REMEDIATION.md) describe that
stack and are kept only as history; do not apply from them.

**Two owners.** Since the adoption described in
[design/smile-to-argo.md](design/smile-to-argo.md):

| What | Owner | How a change ships |
|---|---|---|
| The workload: Deployment, Services, the hashed ConfigMaps, ServiceAccount, SecretProviderClass | Argo CD Application `smilecdr` in `aehrc/sparked-argo` (`apps/smilecdr.yaml`), values from `module-config/` and `deploy/smilecdr/` on `main` here | PR here, merge, then **Sync** the Application by hand (section A) |
| Aurora, the database users, IRSA role and policies, KMS, credential secrets, the generator jars in S3 | Terraform `terraform/` here (sdh-deps v9.0.2, `helm_deploy = false`) | PR here, merge, then a local `terraform apply` (section B) |

Merging to `main` deploys nothing by itself in either case. The `smilecdr`
Application syncs by hand only until automated sync is turned on after the
December 2026 event (a separate, reviewed change in sparked-argo).

The second half of this document,
[Build history](#build-history-standing-up-sparkey-2026-08), records how the
deployment was first built alongside the old one.

## Event change freeze

**No Smile sync and no Smile apply during an event change freeze** except an
emergency fix. For the December 2026 event the freeze runs from Fri 4 Dec 2026,
17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT. The `smilecdr` Application is in
the `sparked` project's deny sync window with `manualSync: true`: the window
stops any automated sync or self-heal, and a manual Sync still goes through for
an emergency. A Terraform apply is still held by convention. The freeze
mechanisms and the emergency path are in sections 2 and 3 of
`docs/runbooks/event-runbook.md` in `aehrc/sparked-argo`; the event's dated
steps are in this repository's operator checklist,
[`docs/operators/events/`](operators/events/). An emergency change is
announced in `#sparked-deployments`.

The planned Smile move before the December freeze is done: aehrc/sparked-argo#384
and this repository's #123 merged on 2026-11-22 (UTC), and Helm release
revision 17 deployed at 2026-11-22T22:19Z. On 2026-11-26 the Smile pod ran on
NodeClaim `on-demand-prod-7v5s5` (`expireAfter: Never`) and the rendered config
had `subscription.rest_hook_enabled = false`.

## A. A workload change (module config, mapped files, chart values)

Every change under `module-config/` (and every mapped file, generated into
`deploy/smilecdr/mapped-files.yaml` by `scripts/render_smile_mapped_files.py`)
reaches the server through the `smilecdr` Application, and **a change that
alters the render rolls the pod**. The chart's `autoDeploy` suffixes ConfigMap
names with a content hash, so new config means a new pod template. The
Deployment is `RollingUpdate` with `maxSurge: 1` and `maxUnavailable: 0`, so the
old pod serves until the new one is ready. A second Smile pod does not fit on
the current `on-demand-prod` node, so Karpenter first launches another node and
the new pod boots there; the emptied node is consolidated afterwards. The
startup probe allows 20 minutes from container start, and the first
`$validate` calls after the roll can answer 504 while the validator warms (see
[sparkey-cutover-runbook.md](sparkey-cutover-runbook.md)). Pick a window
outside events and outside a freeze.

The node runs `PROPERTIES_UNLOCKED` (`module-config/values-sparkey.yaml`): the
rendered config is re-read on every boot, so console edits to module config do
not survive a restart, and a restart does not pick up anything merged since the
last sync.

1. **PR and merge here.** A mapped file change: edit the source under
   `module-config/`, run `python3 scripts/render_smile_mapped_files.py`, commit
   both; CI fails a stale copy.
2. **Snapshot Aurora** if the change can touch data or schema (an IG install,
   a persistence module setting):

   ```bash
   aws rds create-db-cluster-snapshot \
     --db-cluster-identifier smile-smilecluster-sparkey \
     --db-cluster-snapshot-identifier smile-pre-sync-$(date +%Y%m%d-%H%M) \
     --region ap-southeast-2
   ```

3. **Read the diff.** In the Argo CD UI (`https://argo.sparked-fhir.com`,
   Keycloak login), open `smilecdr`, App Diff; or
   `argocd app diff smilecdr`. Expect the new hashed ConfigMap(s), the old
   one(s) to prune, and the Deployment's volume references. Anything else
   (a Service, the ServiceAccount, the SecretProviderClass) is not your change:
   stop and find out why.
4. **Sync with Prune** (UI Sync with Prune ticked, or
   `argocd app sync smilecdr --prune`; without it the superseded ConfigMaps
   stay and the Application stays OutOfSync). Never tick Replace (it drops the
   pod template's `restartedAt`, a second roll) or Force. Check the revision
   the sync panel shows is the merge you mean: a sync renders this repository's
   `main`, so it also ships anything else merged since the last sync. Watch:

   ```bash
   kubectl --context sparkey -n smile rollout status deployment/smilecdr-scdrnode-aucore --timeout=30m
   ```

   `PruneLast` deletes the superseded ConfigMaps only after the new pod is
   healthy.
5. **Verify** (section C).

## B. An infrastructure change (Aurora, IAM, secrets, generator jars)

### Prerequisites

- **Terraform** `1.15.6`. The `smile_cdr_dependencies` module requires
  `>= 1.14.3, < 2.0.0`; the root `provider.tf` only pins `>= 1.5`, but the
  module constraint is the binding one.
- **AWS credentials** for the Sparked AWS account (region `ap-southeast-2`),
  typically AWS SSO with admin access. Confirm with
  `aws sts get-caller-identity`.
- **The two gitignored apply inputs**, `tfvars/sparkey.tfvars` and
  `terraform/backend-sparkey.hcl`, fetched from AWS Secrets Manager rather than
  kept by hand. From the repository root:

  ```bash
  aws sso login --profile csiro-fhir
  export AWS_PROFILE=csiro-fhir
  scripts/fetch-smile-tfvars.sh            # write both files (mode 0600)
  scripts/fetch-smile-tfvars.sh status     # compare local files with the stored copies
  ```

  Reading them needs the `AdministratorAccess` permission set, which is also
  what an apply needs. Where they are kept, who can read them, and how to store
  a changed value after an apply (`scripts/fetch-smile-tfvars.sh push`) are in
  [smile-deploy-inputs.md](smile-deploy-inputs.md). Do not edit a local copy
  without pushing it afterwards: the stored copy should describe what is live.

> **Delete any local `terraform/terraform.tfvars`.** It is a leftover of the
> destroyed dedicated-cluster stack and is not stored or needed:
> `sparkey.tfvars` sets every variable it would set. Terraform still auto-loads
> it on every run, and a `-var-file` only overrides the variables it mentions,
> so a leftover copy pins `smilecdr_iam_role_name` to that stack's IAM role,
> which no longer exists. `scripts/fetch-smile-tfvars.sh` prints a note when it
> finds one.

> **The backend key is in the `-backend-config` file, not in `provider.tf`.**
> If `terraform init` ever prompts interactively for `key`, you passed no
> `-backend-config`: stop rather than typing a value.

### 1. Take a safety snapshot

Aurora cannot be downgraded and some changes cascade to database resources.
Snapshot the Smile Aurora cluster and wait until it is `available`:

```bash
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier smile-smilecluster-sparkey \
  --db-cluster-snapshot-identifier smile-pre-apply-$(date +%Y%m%d-%H%M) \
  --region ap-southeast-2
```

### 2. Init against the sparkey state key

```bash
scripts/fetch-smile-tfvars.sh status    # both inputs match the stored copies
cd terraform
terraform init -reconfigure -backend-config=backend-sparkey.hcl
terraform state list | wc -l    # expect a non-zero count: this is live state
```

A count of 0 means you are pointed at the wrong state. Stop.

### 3. Plan and review

```bash
terraform plan -var-file=../tfvars/sparkey.tfvars -out=sparkey.plan
```

Read the plan before applying. The bar for a steady-state change is:

- **Zero destroys**, and only the in-place changes you intended.
- **No `helm_release` at all.** The workload belongs to Argo CD; a
  `helm_release` create means `helm_deploy` was turned back on, and Helm would
  fight Argo CD for the same objects. Stop.
- No Aurora engine version change (Aurora cannot downgrade; if you see one,
  stop and reconcile).
- No replacement of the KMS secrets alias or the `smilecdr-users-json` /
  DB-user secrets.
- No `aws_route53_record` resources (external-dns owns DNS on sparkey).

If the plan shows unexpected destroys or replacements, do not apply.

### 4. Apply

```bash
caffeinate -i terraform apply sparkey.plan
```

Use `caffeinate` on macOS: a sleeping laptop suspends the terraform process and
its timeouts (see [Apply](#3-apply) in the build history).

### 5. Cross-check the Application

After every apply, check that what the sdh-deps module would pass to Helm still
equals the Application's value files (it fails on a new secret, a renamed role,
a changed database block):

```bash
cd ..   # repository root
python3 scripts/smile_argo_check.py values --argo-repo ../sparked-argo \
  --terraform-output <(cd terraform && terraform output -json smilecdr_helm_values)
```

A difference is investigated, never synced blind: copying Terraform's side
into `apps/smilecdr/values-account.yaml` in sparked-argo can change the render,
and a changed render is a pod roll (a non-empty `specs.hostname`, for example,
also changes every advertised URL). Fix it there only once you know which side
is right, and sync it as a planned change (section A). A module or chart bump: bump the module ref and
`helm_chart_version` in `terraform/main.tf` here first (CI checks they agree),
apply, run this check, then bump `targetRevision` in `apps/smilecdr.yaml` there
(its CI checks it against `main` here).

If you changed `sparkey.tfvars` or the backend file, store it now so the next
operator gets the same inputs: `scripts/fetch-smile-tfvars.sh push` from the
repository root (see [smile-deploy-inputs.md](smile-deploy-inputs.md)).

A new generator jar is section B (the `aws_s3_object`) and then section A (the
`copyFiles` path in `module-config/`).

## C. Verify

```bash
curl -s https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata | jq .software
curl -s https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration | jq .issuer
scripts/upgrade_smoke_tests.sh -o "${TMPDIR:-/tmp}/smile-post-change-$(date +%Y%m%d-%H%M).md"   # from the repository root
```

The smoke tests read a password from the `smilecdr-user-passwords`
secret, so they need an AWS session. The report goes to a temporary
directory, outside the repository, because nothing in `.gitignore` covers it.

`aucore` is the only node. `/ereq/...` and `/hl7au/...` answer 404 by design
(decommissioned 2026-08-03), so do not read a 404 there as a half-failed deploy.

## Rollback

- **The new pod never becomes ready**: the old pod keeps serving
  (`maxUnavailable: 0`) and `PruneLast` has kept its ConfigMaps. Revert the
  change in git and sync again.
- **Data or schema damage**: a last resort. Restoring the snapshot taken before
  the change (`aws rds restore-db-cluster-from-snapshot`) creates a **new**
  Aurora cluster under a new identifier, with no instances until you add one;
  it does not roll `smile-smilecluster-sparkey` back in place. Smile and the
  Terraform state still point at the old cluster, so the new one has to be
  swapped in (Smile's database connection pointed at the new endpoint, or the
  clusters renamed) and Terraform reconciled before you revert the change and
  sync (or apply) the previous good config. None of this has been rehearsed on
  sparkey: the steps are unverified, so work them out with the Sparked
  infrastructure team before starting.
- **Abandoning Argo CD for the workload**: the Rollback section of
  [design/smile-to-argo.md](design/smile-to-argo.md) (delete the Application
  without cascading, `helm_deploy = true`, `terraform import` of the release).

## Build history: standing up sparkey (2026-08)

> **Historical.** The sections below record how this deployment was first built
> in parallel with the dedicated `sparked-smilecdr` stack, before the 2026-08-03
> cutover. "The live server" and "the old server" in them mean that stack, which
> no longer exists. Background and the decision to consolidate:
> `docs/smile-consolidation-evaluation.md` in the internal
> `aehrc/sparked-infrastructure` repository (section 9 is the migration path).

### What is already in place

Landed on sparkey via `aehrc/sparked-argo` (internal) #223 and #224, all verified live:

| Piece | State |
|---|---|
| `on-demand-prod` NodePool | created, 0 nodes (nothing targets it yet) |
| `smile-next.sparked-fhir.com` listener on `main-gateway` | Programmed, Let's Encrypt cert issued |
| DNS for `smile-next` | published by external-dns from the HTTPRoute |
| `smilecdr-aucore` HTTPRoute | admitted; `ResolvedRefs=False` until the Services exist |
| `BackendTrafficPolicy` (16Mi request buffer) | applied |
| `smile` namespace + network policies | ingress and egress, both enforced |

The ArgoCD `smilecdr-routes` app reports **Degraded** until this deploy creates
the backing Services. That is the correct state, not a fault.

### Prerequisites

Same toolchain as the existing runbook (Terraform 1.15.6, AWS SSO credentials
for `ap-southeast-2`). Two extra gitignored files, both with committed
`.example` siblings:

```bash
cd terraform
cp backend-sparkey.hcl.example backend-sparkey.hcl   # set the real state bucket
cp ../tfvars/sparkey.tfvars.example ../tfvars/sparkey.tfvars
```

`sparkey.tfvars` then needs the two values that are never committed:
`cdr_regcred_secret_arn` and `s3_bucket_name`. Both are the same values the
existing deployment uses; the secret and the bucket are shared and read-only
from the server's point of view.

> **Do not delete the `smilecdr_iam_role_name = null` line** from the example.
> `terraform/terraform.tfvars` is auto-loaded on every run and pins that variable
> to the live deployment's role. A `-var-file` only overrides variables it
> actually mentions, so omitting it here does not fall back to the default: the
> production value wins and this deployment attaches its users-secret policy to
> the live IAM role. Verified 2026-08-02 by planning both ways. A later
> `terraform destroy` of this stack in that state would detach a policy from the
> live role.

> **The backend key is no longer in `provider.tf`.** It moved into the
> `-backend-config` file so that a second deployment cannot silently attach to
> live production state. If `terraform init` ever prompts interactively for
> `key`, you passed no `-backend-config`: stop rather than typing a value.

### Deploy

#### 1. Init against the sparkey state key

```bash
cd terraform
terraform init -reconfigure -backend-config=backend-sparkey.hcl
```

Confirm before going further:

```bash
terraform state list | wc -l    # expect 0 on the very first run
```

A non-zero count means you are pointed at the wrong state. Stop.

#### 2. Plan

```bash
terraform plan -var-file=../tfvars/sparkey.tfvars -out=sparkey.plan
```

Expect roughly **66 to add, 0 to change, 0 to destroy**. Sanity checks worth
making on the plan rather than trusting the count:

- `aws_rds_cluster` identifier is `smile-smilecluster-<deployment>`, engine
  `aurora-postgresql` `16.13`
- security group rules reference sparkey's VPC (this repo is public, so get the
  id from `terraform output` or the EKS console rather than from here) and its
  worker-node security group
- the IAM policy is `smile-users-secret-access-sparkey` and the role attachment
  targets `smile-smilecdr-<deployment>`, neither colliding with the live
  `smile-users-secret-access` / `smile-smilecdr-dff66d5832d6f1c8`
- **no `aws_route53_record` resources at all** (external-dns owns DNS here)
- the `helm_release` targets namespace `smile`

#### 3. Apply

```bash
caffeinate -i terraform apply sparkey.plan
```

**Use `caffeinate`.** This apply creates an Aurora cluster and then waits on a
first-boot schema migration, so 20 to 30 minutes is normal. If the laptop sleeps
mid-apply the terraform process is suspended: Go timers run off the monotonic
clock, which does not advance during macOS sleep, so `helm_chart_timeout` never
fires while the wall-clock "elapsed" counter races ahead. One apply was observed
reporting 448 minutes elapsed without ever timing out, while the same timeout
fired correctly at 30:23 on a run that stayed awake.

The Aurora cluster is the long pole, typically 15 to 20 minutes. The Helm
release then waits on pod readiness; Smile CDR's own startup probe allows up to
30 minutes, so a slow first boot is not a failure.

#### 4. Watch the first pod carefully

This is the first time the network policies meet a real workload, and they were
written from the old cluster's pod rather than observed here. If something is
going to be wrong, it is most likely here.

```bash
kubectl --context sparkey -n smile get pods -w
kubectl --context sparkey -n smile describe pod -l app.kubernetes.io/name=smilecdr
```

Watch for the pod stuck `Pending` (the prod NodePool did not provision, or the
toleration/nodeSelector pair is wrong) or the init containers failing (S3 egress
blocked). Cross-check the deny log in Grafana: `{log_type="netpol"}`.

A node should appear on the `on-demand-prod` pool within a minute or two:

```bash
kubectl --context sparkey get nodes -l workload=prod
```

Expect a single `r6a.large`.

### Seeding

Config, packages and the SMART post-authorize script arrive with the Helm
release. Everything else is deliberate.

**Do seed:**

- **Test data.** `sparked-test-data-loader` already runs on this cluster. The
  data uses client-assigned IDs and is loaded by `PUT`, so a rebuild reproduces
  byte-identical resource IDs and no external reference breaks.
- **`ADMIN` / `ANONYMOUS`.** These come from the `smilecdr-users-json` secret,
  which both deployments read, so they are created by the release itself.

**Do NOT seed, decided 2026-08-02:**

- **The connectathon users and clients.** `module-config/connectathon-users.json`
  and `connectathon-clients.json` are not actively maintained and their
  permissions have drifted from intent: `connectathon-user-05`,
  `connectathon-user-06` still carry `permissionLevel: read-write`, and
  `connectathon-backend-02` still carries scope `system/*.*` which
  `scopes_to_authorities` maps to `FHIR_ALL_WRITE` + `FHIR_TRANSACTION`. On the
  live server all three were reduced to read-only by multitenancy Phase 2, and
  running `manage_smart_users.py` / `register_smart_client.py` against a fresh
  server would silently restore write access to the curated `DEFAULT` dataset.

  So: do not run those scripts as part of this build. Principals get recreated
  from actual demand, through the normal issue-template route, which also gives
  the set a chance to be pruned rather than carried forward. Revisit the two
  JSON files separately.

- **Partitions.** The only non-DEFAULT partition anywhere is the disposable
  `VENDOR-DEMO`. The rebuilt server starts with `DEFAULT` alone. Codifying
  partitions is Phase 3 step 2 of the multitenancy rollout and is not a
  prerequisite here; see
  [multitenancy-rollout-plan.md](multitenancy-rollout-plan.md).

### smart_auth needs no post-deploy step

An earlier version of this runbook required `scripts/sync_smart_auth.py` after
every deploy. It does not, and running it would not have held anyway.

`smart_capabilities_list` now lives in `module-config/simplified-multinode.yaml`
using escaped newlines (`\n`, single-quoted in YAML), which java.util.Properties
unescapes back into the multi-line value the module expects. Verified by
rendering the chart offline before applying, and confirmed live: the module
parses 10 entries including `context-ehr-encounter`.

The reason this matters rather than being a style choice: this node runs
`PROPERTIES_UNLOCKED`, where properties are re-read and overwrite module config
on every boot. Measured 2026-08-03 by applying the script and restarting the pod,
the script's changes were gone. Anything that must survive a restart has to be in
the config, not applied over the admin API afterwards.

`sync_smart_auth.py` was useful against the old dedicated-cluster deployment,
which ran `DATABASE` mode where API changes did persist. That deployment was
destroyed on 2026-08-27, so no deployment remains where its changes last.

### Verify

Two paths, and the second is the one that counts.

**Browsing, for a human comparison against the live server:**

```bash
curl -s https://smile-next.sparked-fhir.com/aucore/fhir/DEFAULT/metadata | jq .fhirVersion
```

Note that response bodies here advertise `smile.sparked-fhir.com`, so pagination
links and `entry.fullUrl` point at the OLD server. That is deliberate:
`specs.hostname` is kept at the real name so this deployment runs the exact
production config and cutover needs no restart. See the header of
`module-config/values-sparkey.yaml`.

**The acceptance gate**, which exercises the real Host and therefore the real
SMART configuration:

```bash
./scripts/upgrade_smoke_tests.sh \
  --connect-to <sparkey gateway LB hostname> \
  -o sparkey-build.md
```

> **This does not work until cutover prep adds a `smile-https` listener.** The
> sparkey Gateway currently has a listener for `smile-next.sparked-fhir.com`
> only, so a request carrying `Host: smile.sparked-fhir.com` fails TLS SNI and
> the connection is refused (observed as curl exit 000, not an HTTP error). Until
> that listener exists, verification has to go through `smile-next`, which does
> not exercise the SMART discovery path against the production hostname. Add the
> listener before relying on this as the acceptance gate.

Compare against a baseline captured from the live server the same day.

Also confirm telemetry: the OTLP endpoint
(`k8s-monitoring-alloy-metrics.monitoring.svc.cluster.local:4317`) resolves on
this cluster unchanged, so traces and metrics should appear in sparkey's LGTM
with no config edit.

### Rollback

Nothing to roll back in the sense that matters: the live server is untouched
throughout and keeps serving `smile.sparked-fhir.com`. Abandoning this build is
`terraform destroy -var-file=../tfvars/sparkey.tfvars` against the sparkey state
key, which removes the Aurora cluster, the IAM, the secrets and the release.
The sparked-argo manifests are additive and can stay.

Take a final snapshot before any destroy if the server has been used for
anything worth keeping.

### Known risks

- **Network policies are unvalidated against a running workload.** They were
  derived from the pod on the old cluster. Reconcile from the deny log before
  cutover; rollback is a one-file delete in sparked-argo.
- **Parallel running costs roughly $150 to $200/mo**, mostly the second Aurora
  (min 0.5 ACU when idle) plus one `r6a.large`.
- **Partition seed restart semantics are unverified** (see the multitenancy
  plan). Not exercised by this build.
