# Design: the Smile CDR workload as an Argo CD Application

**Status: proposed. A plan for after the December 2026 event freeze ends (Fri
11 Dec 2026), not for now.** Nothing here should be started inside the run-up to
the 8 to 10 Dec connectathon or during its freeze. Until it lands, Smile is
deployed by a local `terraform apply` as described in
[sparkey-deploy-runbook.md](../sparkey-deploy-runbook.md), with the inputs from
[smile-deploy-inputs.md](../smile-deploy-inputs.md) once that lands.

## Why

Every other workload on the `sparkey` cluster is deployed by Argo CD from
`aehrc/sparked-argo`. Smile CDR is the exception: a change to `module-config/`
merges to `main`, deploys nothing, and reaches the server only when someone with
AWS administrator access runs `terraform apply` from a workstation. That has
three costs:

- **Deploys depend on one person and one machine.** The apply needs gitignored
  inputs, an SSO session and a laptop that stays awake for up to 30 minutes.
- **Drift is invisible.** The node runs `PROPERTIES_UNLOCKED`, so it boots from
  the ConfigMaps of the last apply. If `main` has moved on since, nothing shows
  it.
- **Freezes are a convention.** Argo sync windows can stop every other app
  during an event; nothing mechanical stops a Smile apply.

The decision (D3, option A, ruled on 21 Nov 2026) is to move the Smile
**workload** to an Argo CD Application after the event, keep Aurora, S3 and IAM
in Terraform, keep the values in this public repository, and bring secrets in
through External Secrets Operator (ESO).

## What exists today (checked live, read-only, 21 Nov 2026)

- Terraform stack `terraform/` calls the Smile `sdh-deps` module (v9.0.2). It
  creates the Aurora cluster, the database users (through a Lambda), the IRSA
  role and policies, a KMS key, the database credential secrets, the S3 objects
  for the AU PS generator jars, **and** a `helm_release` named `smilecdr`.
- That Helm release: chart `smilecdr` 9.0.2 from the Smile GitLab Helm
  repository (`stable` channel), namespace `smile`, revision 16, deployed
  2026-09-11 (the last apply). It owns 23 objects: one Deployment
  (`smilecdr-scdrnode-aucore`), six Services, a PodDisruptionBudget, a
  ServiceAccount, a SecretProviderClass and 13 ConfigMaps.
- Argo CD already owns the routes and network policies for the namespace
  (`apps/smilecdr-routes.yaml` in sparked-argo, project `sparked`).
- Secrets reach the pod through the Secrets Store CSI driver (AWS provider):
  database credentials, the image pull secret, `users.json` and the token
  signing keystore are mounted and synced from AWS Secrets Manager by the
  SecretProviderClass.
- `autoDeploy: true` (the chart default). Every ConfigMap the chart renders from
  config or a mapped file carries a content hash in its name, and the
  Deployment mounts it by that name. Changed config means a new ConfigMap name,
  a new pod template, and a rolling restart. An unchanged render means no
  restart.
- The Deployment is `RollingUpdate` with `maxSurge: 1`, `maxUnavailable: 0`, so
  the old pod serves until the new one is ready. The startup probe allows
  120 x 10 s before giving up.

**Adoption without a pod roll is feasible.** `helm template` of chart 9.0.2
with the release's own values (`helm get values smilecdr -n smile`) reproduces
all 23 live objects field for field (compared against
`helm get manifest smilecdr -n smile`). The chart uses no `lookup`, no random
or time functions and no `.Capabilities`, so Argo CD's render is the same as
Helm's. The only extra object in the render is the chart's Helm test Pod
(`helm.sh/hook: test`), which Helm never installs either.

## Target ownership

| Piece | Owner after the move |
|---|---|
| Aurora cluster, DB users, KMS keys, DB credential secrets | Terraform (`sdh-deps`, unchanged) |
| IRSA role and policies, `iam-users-secret.tf` | Terraform |
| AU PS generator jars in S3 (`aws_s3_object`) | Terraform |
| Smile Deployment, Services, ConfigMaps, PDB, ServiceAccount | Argo CD Application `smilecdr` (sparked-argo `apps/smilecdr.yaml`, project `sparked`) |
| HTTPRoutes, network policies | Argo CD (unchanged) |
| Chart values (`module-config/*.yaml`, mapped files) | This repository, public |
| Account-specific values (IRSA role ARN, secret names, S3 bucket if kept private) | sparked-argo (private), a values file next to the Application |
| Secrets | AWS Secrets Manager, delivered by ESO (second step, below) |

Terraform keeps the module and sets `helm_deploy = false`. The module still
computes its Helm values as an output (`helm_chart_values`), which is the
cross-check for the account-specific file.

## The Application

Multi-source, the pattern `apps/inferno-dev.yaml` already uses:

- **Chart source:** `https://gitlab.com/api/v4/projects/40759898/packages/helm/stable`,
  chart `smilecdr`, `targetRevision: 9.0.2`, `helm.releaseName: smilecdr`
  (Argo otherwise names the release after the Application, and every object
  name would change). The repository URL is added to `sourceRepos` in
  `projects/proj-sparked.yaml`.
- **Values from this repository** (`ref: values`, `targetRevision: main`), in
  today's merge order, overlays last: `module-config/values-common.yaml`,
  `module-config/simplified-multinode.yaml`, `module-config/values-sparkey.yaml`,
  then a generated `deploy/smilecdr/mapped-files.yaml`.
- **Account values from sparked-argo** (`ref: deploy`):
  `apps/smilecdr/values-account.yaml` with the IRSA role ARN, the secret
  references and the `secrets.usersConfig` secret. Its content is what the
  module injects today, taken from the `helm_chart_values` output and the
  `helm_chart_values_set_overrides` in `terraform/main.tf`.
- **Sync options:** `PruneLast=true`, so superseded hashed ConfigMaps are deleted
  only after the new pod is healthy and the old pod is gone. Client-side apply
  (the default), not server-side apply: the live objects are owned by the
  `helm` field manager, and server-side apply would conflict with it on the
  first sync.
- **Sync policy:** manual for the adoption, then `automated` with `prune` and
  `selfHeal`, matching the other apps.

### Two changes to the values files

1. **`${s3_bucket}` placeholders.** `simplified-multinode.yaml` uses
   `templatefile()` placeholders for the jar bucket. Argo cannot substitute them.
   Either commit the bucket name (it is not a credential and already appears in
   `docs/sparkey-cutover-runbook.md`) or move each node's `copyFiles` block into
   the private account values file. Lean: commit it; one file stays readable.
2. **Mapped files.** Today `terraform/main.tf` inlines the package specs and the
   two JavaScript files into the values with `file()`. Helm values cannot read
   files, so a script (`scripts/render-smile-mapped-files.py`) writes
   `deploy/smilecdr/mapped-files.yaml` from the same list, and
   `validate-config.yml` fails a PR whose generated file is stale. The bytes
   must match exactly: the chart hashes each file's content into its ConfigMap
   name, so a changed trailing newline is a pod roll. Argo's
   `helm.fileParameters` (the `--set-file` equivalent) would avoid the generated
   file, but whether it accepts `$values` paths in a multi-source Application is
   unverified.

## Adoption, step by step

Done in one maintenance window outside any event, by someone with SSO
`AdministratorAccess`, after a clean `terraform plan` (no changes) proves live
equals `main`.

1. **Prove the render offline.** Render exactly what Argo will:

   ```bash
   helm pull smilecdr --repo https://gitlab.com/api/v4/projects/40759898/packages/helm/stable \
     --version 9.0.2 -d /tmp/smile-adopt
   helm template smilecdr /tmp/smile-adopt/smilecdr-9.0.2.tgz -n smile \
     -f module-config/values-common.yaml -f module-config/simplified-multinode.yaml \
     -f module-config/values-sparkey.yaml -f deploy/smilecdr/mapped-files.yaml \
     -f <sparked-argo>/apps/smilecdr/values-account.yaml > /tmp/smile-adopt/argo.yaml
   helm get manifest smilecdr -n smile --kube-context sparkey > /tmp/smile-adopt/live.yaml
   ```

   Compare the two object by object (kind and name, then a sorted-keys JSON
   comparison of each). The gate: no object differs, nothing is only in
   `live.yaml`, and the only object only in `argo.yaml` is the test Pod.
   Commit the comparison script with the generator so it can be rerun.

2. **Land the values PR in this repository** (generated file, placeholder
   change, CI check). Nothing deploys yet: Terraform still renders the same
   values, and its next plan must still show no changes.
3. **Land the Application in sparked-argo with manual sync.** Argo shows it
   OutOfSync. `argocd app diff smilecdr` must show metadata only (the tracking
   annotation and `last-applied-configuration`), nothing under `spec` of any
   object.
4. **Sync once by hand.** Watch that the pod keeps its name and age:
   `kubectl --context sparkey -n smile get pods`. A new pod here means the
   render differed: the old pod keeps serving (`maxUnavailable: 0`), so let the
   roll finish and find the difference before going further.
5. **Hand over from Terraform in the same window.** First forget the release
   in state (the state bucket is versioned, so this is recoverable):

   ```bash
   terraform state rm 'module.smile_cdr_dependencies.helm_release.smilecdr[0]'
   ```

   Then a PR here sets `helm_deploy = false` on the module; its plan must show
   no changes. **Never plan or apply `helm_deploy = false` with the release
   still in state:** Terraform would destroy it, and a Helm uninstall deletes
   the Deployment. A declarative `removed` block does not work here: Terraform
   refuses one while the module still declares the resource (count 0 or not),
   and the module is upstream code. Checked with Terraform 1.15.6 on a
   throwaway module: `removed` fails with "Removed resource still exists";
   `state rm` followed by count 0 plans no changes.
6. **Turn on automated sync** after a day with no diff.
7. **Leave the Helm release secrets** (`sh.helm.release.v1.smilecdr.v*`) for 30
   days as the rollback path, then delete them. Argo does not track them.

One stray ConfigMap is not part of the release today
(`smilecdr-scdr-package-au-base-6-1-1-draft-json-02ed8b...`, a leftover of an
earlier revision). Argo will not touch it; delete it by hand after adoption.

## Secrets through ESO (second step, one planned roll)

Swapping the Secrets Store CSI driver for ESO changes the pod template (volumes
and the image pull secret reference), so it is a pod roll. Do it as its own
change, after adoption has settled:

- ExternalSecrets in sparked-argo (next to the Application) for the database
  credentials (`smile-SmileCluster-*-sparkey`), `users.json`
  (`smilecdr-users-json`), the token signing keystore
  (`smilecdr-token-signing-jwks`) and the image pull secret (a
  `kubernetes.io/dockerconfigjson` template over the registry credential).
- A reader role for the `smile` namespace in `aehrc/sparked-infrastructure`
  (`secrets_readers` in `sparkey-eks/iam.tf`), with `kms:Decrypt` on the
  module's secrets key for the database credentials. The Crossplane-readable
  prefixes deliberately exclude these secrets.
- Chart values switch each secret to `type: k8sSecret` with the ESO-created
  Secret's name. The chart supports this for the database credentials, image
  pull secrets, the licence and the generic `secrets` block.
- Then remove the SecretProviderClass and the CSI driver dependency for this
  namespace.

## How day-to-day changes work afterwards

- **A config change** is a PR to `module-config/`. Merging it is the deploy:
  Argo renders a new hashed ConfigMap, the pod template changes, and the pod
  rolls (up to the startup probe's limit, while the old pod serves). The
  ruleset on `main` (one approval) is the review gate; `pr-merged.yml` and the
  docs that say "applied on the next terraform apply" change accordingly.
- **A new generator jar** still needs Terraform first (the `aws_s3_object`),
  then the values PR that points `copyFiles` at it.
- **An IG release** that persists `startup_installation_specs` becomes a values
  PR, not a local apply.
- **Console edits** are still lost on restart (`PROPERTIES_UNLOCKED`), and Argo
  `selfHeal` now also reverts `kubectl edit` on the Deployment.
- **Chart upgrades** bump `targetRevision` in sparked-argo. Module upgrades
  (Aurora, IAM) stay in Terraform and no longer move the workload.

## Freezes

The `smilecdr` Application joins the event-relevant apps in the `sparked`
project's sync windows (the freeze model in sparked-argo): a `deny` window for
the freeze dates with `manualSync: true`, so an emergency fix can still be
synced by hand. A deny window also suspends `selfHeal`, which is what a freeze
wants. Node expiry on the `on-demand-prod` pool is a separate control
(Karpenter) and is not affected by this change.

## Rollback

- **A bad config change:** `git revert` the PR; Argo rolls the pod back to the
  previous hashed ConfigMaps. Argo's own history rollback works too, but only
  with automated sync off, and git stays the record.
- **Abandoning the migration:** delete the Application without cascading
  (`argocd app delete smilecdr --cascade=false`, or remove its finalizer first)
  so the workload stays up; set `helm_deploy = true`; import the release with
  `terraform import 'module.smile_cdr_dependencies.helm_release.smilecdr[0]' smile/smilecdr`
  (the Helm release secrets kept in step 7 make this possible); a plan should
  then show no changes.

## Open questions

1. Commit the S3 bucket name in `simplified-multinode.yaml`, or keep the
   `copyFiles` blocks in the private account values?
2. Does Argo CD (v3.6.2 live) skip the chart's `helm.sh/hook: test` Pod, as it
   does other unsupported Helm hooks? Check with `argocd app manifests smilecdr`
   before the first sync; if it would create the Pod, exclude it.
3. `helm.fileParameters` with a `$values` path in a multi-source Application:
   supported? If yes, it replaces the generated mapped-files file.
4. Who holds the `argocd` CLI login for the adoption sync (Keycloak `aehrc`
   realm, Argo RBAC)?
5. Should the disabled `smile-application.yml` workflow and its repository
   variables be deleted once Terraform no longer deploys the workload?
