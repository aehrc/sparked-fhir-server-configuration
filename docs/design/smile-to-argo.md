# Design: the Smile CDR workload as an Argo CD Application

**Status: accepted, being implemented before the December 2026 event freeze.**
The adoption runs in one weekday window between 10:00 and 15:00 AEDT before
Thu 3 Dec 2026, so the freeze that starts Fri 4 Dec 17:00 AEDT covers Smile
mechanically for the first time. It changes no pod template, so Smile does not
restart. The one step that does restart Smile, secrets through External Secrets
Operator, is separate and planned for after the event. Until the adoption
lands, Smile is deployed by a local `terraform apply` as described in
[sparkey-deploy-runbook.md](../sparkey-deploy-runbook.md).

The pieces:

| Change | Repository | Merge |
|---|---|---|
| Values Argo CD can read: the bucket name committed, `deploy/smilecdr/mapped-files.yaml` generated, the checks in `scripts/smile_argo_check.py`, CI | this one | before the window; changes nothing live (Terraform renders the same values) |
| The `smilecdr` Application, its account values, the freeze window, the pairing check | aehrc/sparked-argo | in the window; the Application appears OutOfSync and does nothing until synced by hand |
| Terraform stops deploying the workload (`helm_deploy = false`), the CI workflow retired, the runbooks rewritten | this one | in the window, **only after** `terraform state rm` (step 5) |

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
**workload** to an Argo CD Application, keep Aurora, S3 and IAM in Terraform,
keep the values in this public repository, and bring secrets in through External
Secrets Operator (ESO). D3 said "after the event"; on 26 Nov 2026 the owner
moved the adoption ahead of it, because the repository is quiet now and a
zero-diff adoption carries no restart.

## What exists today (checked live, read-only, 26 Nov 2026)

- Terraform stack `terraform/` calls the Smile `sdh-deps` module (v9.0.2). It
  creates the Aurora cluster, the database users (through a Lambda), the IRSA
  role and policies, a KMS key, the database credential secrets, the S3 objects
  for the AU PS generator jars, **and** a `helm_release` named `smilecdr`.
- That Helm release: chart `smilecdr` 9.0.2 from the Smile GitLab Helm
  repository (`stable` channel), namespace `smile`, **revision 17, deployed
  23 Nov 2026** (the apply of #123). It owns 23 objects: one Deployment
  (`smilecdr-scdrnode-aucore`), six Services, a PodDisruptionBudget, a
  ServiceAccount, a SecretProviderClass and 13 ConfigMaps. Its values equal
  `main` exactly: every module-config file, and all 12 mapped files byte for
  byte.
- The Deployment's pod template also carries
  `kubectl.kubernetes.io/restartedAt` from a `kubectl rollout restart` on
  24 Nov (ReplicaSet `6467767574`, generation 19). Helm did not render it and
  keeps it; so does Argo CD (below).
- Argo CD already owns the routes and network policies for the namespace
  (`apps/smilecdr-routes.yaml` in sparked-argo, project `sparked`).
- Argo CD is v3.6.2, which bundles Helm v4.3.2. It tracks resources by
  annotation (`argocd.argoproj.io/tracking-id`, the 3.x default; the cluster
  does not set `application.resourceTrackingMethod`), diffs client-side, and
  applies client-side unless an Application asks for server-side apply.
- Secrets reach the pod through the Secrets Store CSI driver (AWS provider):
  seven database credential secrets (`smile-SmileCluster-<db>-sparkey`,
  encrypted with the module's own KMS key), the image pull secret
  (`example-key-value`), `smilecdr-users-json` and
  `smilecdr-token-signing-jwks` (the last three on the AWS-managed key), all
  mounted by the SecretProviderClass under the IRSA role
  `smile-smilecdr-sparkey`.
- `autoDeploy: true` (the chart default). Every ConfigMap the chart renders from
  config or a mapped file carries a content hash in its name, and the
  Deployment mounts it by that name. Changed config means a new ConfigMap name,
  a new pod template, and a rolling restart. An unchanged render means no
  restart.
- The Deployment is `RollingUpdate` with `maxSurge: 1`, `maxUnavailable: 0`, so
  the old pod serves until the new one is ready. The startup probe allows
  120 x 10 s before giving up.
- The Smile node pool `on-demand-prod` is `expireAfter: Never` and its node was
  replaced on 23 Nov, so no node roll is pending before the event.

## Zero-diff evidence

`scripts/smile_argo_check.py` reads the Application itself (chart, version,
release name, value files in order) and runs three checks. All three passed on
26 Nov 2026 against release revision 17:

1. **`values`**: Terraform's values (here `helm get values`; after the
   hand-over the `smilecdr_helm_values` Terraform output) merged as Helm merges
   them, against the Application's five value files merged the same way:
   225 leaves, 0 differences.
2. **`render`**: the chart rendered with the Helm that Argo CD bundles
   (`--argocd-image quay.io/argoproj/argocd:v3.6.2`), compared object by object
   with `helm get manifest`: 23 of 23 identical, nothing only on one side (the
   test Pod is skipped, see below).
3. **`dry-run`**: that render, carrying the tracking annotation Argo CD adds,
   through `kubectl diff` (a server-side dry run, nothing written) against the
   live objects. Every object changes only by gaining that annotation. The
   Deployment's `generation` goes from 19 to 20: the Deployment registry counts
   an annotation change as a generation bump, "because annotations are copied
   from deployments to their replica sets" (Kubernetes
   `pkg/registry/apps/deployment/strategy.go`). Its spec, and so its pod
   template and ReplicaSet hash, are identical: no new ReplicaSet, no restart.
   Argo CD's apply also writes `kubectl.kubernetes.io/last-applied-configuration`,
   another annotation of the same kind.

The chart uses no `lookup`, no random or time functions and no `.Capabilities`
outside `NOTES.txt`, so the render does not depend on the cluster.

The `restartedAt` annotation survives because a client-side apply computes its
patch three ways against `last-applied-configuration`, and the live objects
have none: with nothing "previously applied", it deletes nothing it does not
render. After the first sync the annotation it writes does not contain
`restartedAt` either, so later syncs leave it alone too.

## Target ownership

| Piece | Owner after the move |
|---|---|
| Aurora cluster, DB users, KMS keys, DB credential secrets | Terraform (`sdh-deps`, unchanged) |
| IRSA role and policies, `iam-users-secret.tf` | Terraform |
| AU PS generator jars in S3 (`aws_s3_object`) | Terraform |
| Smile Deployment, Services, ConfigMaps, PDB, ServiceAccount, SecretProviderClass | Argo CD Application `smilecdr` (sparked-argo `apps/smilecdr.yaml`, project `sparked`) |
| HTTPRoutes, network policies | Argo CD (unchanged) |
| Chart values (`module-config/*.yaml`, `deploy/smilecdr/mapped-files.yaml`) | This repository, public |
| Account-specific values (IRSA role ARN, secret ARNs, database wiring) | sparked-argo (private), `apps/smilecdr/values-account.yaml` |
| Secrets | AWS Secrets Manager, through the CSI driver until the ESO step |

Terraform keeps the module and sets `helm_deploy = false`, which gates only the
module's `helm_release` and its `helm_template` data source. The module still
computes its Helm values (`helm_chart_values`), and the root output
`smilecdr_helm_values` exposes them with the `--set` overrides, for the
cross-check below.

## The Application

Multi-source, the pattern `apps/inferno-dev.yaml` and `apps/sparked-sandbox.yaml`
already use:

- **Chart source:** `https://gitlab.com/api/v4/projects/40759898/packages/helm/stable`,
  chart `smilecdr`, `targetRevision: 9.0.2`, `helm.releaseName: smilecdr`
  (Argo otherwise names the release after the Application) and
  `helm.skipTests: true` (the chart's test Pod is not rendered). The repository
  URL is added to `sourceRepos` in `projects/proj-sparked.yaml`.
- **Values from this repository** (`ref: values`, `targetRevision: main`), in
  Terraform's merge order: `module-config/values-common.yaml`,
  `module-config/simplified-multinode.yaml`, `module-config/values-sparkey.yaml`,
  then the generated `deploy/smilecdr/mapped-files.yaml`.
- **Account values from sparked-argo** (`ref: deploy`):
  `apps/smilecdr/values-account.yaml`, last. It holds what the module injected:
  `database.external` (the seven credential secrets), `image.imagePullSecrets`,
  the `secrets.*.secretArn` overrides, the ServiceAccount's IRSA annotation,
  `specs.hostname: ''` (no module-managed ingress) and `replicaCount: 1`.
  ARNs and names only.
- **No resources finalizer**, so removing the file (the app-of-apps prunes the
  Application without cascading) or `kubectl -n argocd delete application
  smilecdr` leaves Smile running. **Not** so for the two usual ways of
  deleting: `argocd app delete` defaults to `--cascade=true` and the UI's
  delete dialog to Foreground, and Argo CD then adds the finalizer itself and
  deletes all 23 objects, Deployment included. The rollback below names the
  safe commands.
- **Sync options:** `PruneLast=true`, so superseded hashed ConfigMaps are deleted
  only after the new pod is healthy; a config change whose pod never becomes
  ready leaves the old ConfigMaps in place. A manual sync prunes only when
  asked (`argocd app sync smilecdr --prune`, or tick Prune in the UI): without
  it the old ConfigMaps stay, marked "requires pruning", and the Application
  stays OutOfSync, which would hide real drift. Client-side apply (the default), not
  server-side apply: the live objects are owned by the `helm` field manager,
  and server-side apply would conflict with it on the first sync.
- **No `CreateNamespace`, no `managedNamespaceMetadata`:** the namespace
  exists and `smilecdr-routes` declares it.
- **Sync policy: manual**, for the adoption and through the event. A merge to
  `module-config/` then shows the Application OutOfSync and rolls nothing until
  someone presses Sync. Turning on `automated` (prune, selfHeal) is its own
  reviewed change after the event.

Smile's chart documentation ("ArgoCD Considerations" in `docs/guide/smilecdr/updating.md`
of smile-dh-helm-charts) recommends `argocd.enabled: true`, which marks the
hashed ConfigMaps `Prune=false` and `IgnoreExtraneous` so an old ReplicaSet can
still scale. It is **not** set here: it changes the render, so the adoption
would no longer be zero-diff, and it keeps every superseded ConfigMap forever.
Today Helm deletes the old ConfigMaps at upgrade time, before the new pod is
ready; `PruneLast` deletes them later than that, so the behaviour is no worse
than under Terraform. Reconsider it with the move to automated sync. The same
guide's "umbrella chart" advice predates multi-source Applications.

### The two values changes (done)

1. **The bucket name is committed** in `simplified-multinode.yaml`
   (`examplebucket-fhir-aws`, the three `copyFiles` blocks). It is not a
   credential and already appears in `docs/sparkey-cutover-runbook.md`.
   Terraform's `templatefile()` renders the same text, so its plan is unchanged.
2. **Mapped files are generated.** `scripts/render_smile_mapped_files.py`
   writes `deploy/smilecdr/mapped-files.yaml` (path and exact bytes of the
   twelve package specs and scripts), parses it back and fails unless every
   file round-trips byte for byte; the chart hashes each file into a ConfigMap
   name, so a changed trailing newline is a pod roll. `validate-config.yml`
   fails a PR whose copy is stale. The script's list is the single list: after
   the hand-over `terraform/main.tf` reads the same file. Argo CD 3.6.2 also
   resolves `$ref` paths in `helm.fileParameters` (`reposerver/repository/repository.go`),
   which would avoid the generated file, but `--set-file` keys with dots in
   them (`package-aucore-3.0.0-ballot1.json`) need escaping, and the list would
   live in the private repository; the generated file keeps both here.

### Keeping the module and the Application honest

Moving off the module's `helm_release` keeps everything the module maintains
that matters, as long as two things cannot drift silently:

- **What the module injects.** After any `terraform apply` here, and before a
  module or chart bump, run
  `python3 scripts/smile_argo_check.py values --argo-repo <sparked-argo> --terraform-output <(cd terraform && terraform output -json smilecdr_helm_values)`.
  It fails on any value the module would set differently from the Application's
  files, for example a new secret, a renamed role or a changed database block
  in a new module release. The output includes the module's own `--set`
  overrides (`replicaCount` and `specs.hostname`, which it sets to its
  `public_fqdn`, empty here), so today's live state compares clean. **A
  difference is investigated, never synced blind:** copying Terraform's side
  into `values-account.yaml` can change the render, and a changed render is a
  pod roll (a non-empty `specs.hostname`, for example, also changes every
  advertised URL).
- **The module and chart versions.** sdh-deps v9.0.2 and chart 9.0.2 are
  released together. `smile_argo_check.py pairing` (this repository's CI)
  checks that the module ref and `helm_chart_version` in `terraform/main.tf`
  agree; sparked-argo's `scripts/check-smilecdr-pairing.py` (its CI) checks
  that the Application's `targetRevision` equals them on `main` here. Bump this
  repository first (Terraform only, no deploy), run the `values` check, then
  bump the Application.

Whether Smile's support covers the chart deployed by Argo CD with dependencies
from their module is **unverified**. Their chart documentation describes Argo CD
deployment and ships the `argocd.enabled` flag, and `helm_deploy` is a
documented module input ("Deploy using the Smile CDR Helm Chart"), but nothing
in the chart or module documentation states the support position. Ask Smile
support before relying on it.

## Adoption, step by step

One weekday window, 10:00 to 15:00 AEDT, outside the freeze, by someone with
SSO `AdministratorAccess` (for steps 5 and 6) and Argo CD sync rights (step 4),
with a second person watching. Rehearsed offline; the live steps are 3 to 6.

0. **Before the window**: the values PR here merged (it changes nothing live),
   the sparked-argo PR and the hand-over PR approved, the hand-over PR rebased
   onto `main` the day before. Ask maintainers not to merge to this
   repository's `main` during the window: Argo CD renders it at sync time, so a
   merge between the checks and the sync ships with the adoption. Run the
   three checks against the sparked-argo PR's branch now, and again against
   both `main`s once step 2 has merged it:

   ```bash
   git fetch origin && git checkout --detach origin/main      # in both checkouts, after step 2
   python3 scripts/smile_argo_check.py values --require-main --argo-repo ../sparked-argo \
     --helm-values <(helm get values smilecdr -n smile --kube-context sparkey -o yaml)
   python3 scripts/smile_argo_check.py render --require-main --argo-repo ../sparked-argo \
     --argocd-image quay.io/argoproj/argocd:v3.6.2
   python3 scripts/smile_argo_check.py dry-run --require-main --argo-repo ../sparked-argo \
     --argocd-image quay.io/argoproj/argocd:v3.6.2
   ```

   Each prints the two commits it checked (`--require-main` refuses anything
   but a clean `origin/main`; leave it out for the branch run). The gate:
   `differences: 0`, `identical objects: 23`, and
   `objects with a change beyond Argo CD's metadata annotations: 0`, with the
   Deployment line reading `spec.template identical`. Anything else: stop.
1. **Record the baseline**:
   `kubectl --context sparkey -n smile get pods,rs -o wide` (pod name, age,
   ReplicaSet `6467767574` or whatever is current).
2. **Merge the sparked-argo PR.** The app-of-apps creates the `smilecdr`
   Application, OutOfSync, with no operation. Nothing is applied. Run the step
   0 checks again with `--require-main`.
3. **Read Argo CD's own diff** (UI: the Application, App Diff; or
   `argocd app diff smilecdr` after `argocd login argo.sparked-fhir.com --sso`).
   It must show annotations only, nothing under `spec`. The test Pod must not
   appear.
4. **Sync once by hand**, default options only (UI Sync, or
   `argocd app sync smilecdr`). Before pressing it, check that the revisions
   the sync panel shows are the two commits step 2's checks printed. Never
   tick Replace (it rewrites each object whole and drops the pod template's
   `restartedAt`: a pod roll) or Force (delete and recreate). Prune is not
   needed: nothing is tracked yet, so nothing can be pruned. Watch
   `kubectl --context sparkey -n smile get pods -w`: the pod keeps its name and
   age, and no new ReplicaSet appears. A new pod here means the render
   differed: the old pod keeps serving (`maxUnavailable: 0`), so let the roll
   finish, and find the difference before going further. Then:
   `curl -s -o /dev/null -w '%{http_code}\n' https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata`
   prints `200`, and the Application is Synced and Healthy.
5. **Hand over from Terraform in the same window.** Forget the release in state
   (the state bucket is versioned, so this is recoverable):

   ```bash
   cd terraform
   terraform init -reconfigure -backend-config=backend-sparkey.hcl
   terraform state rm 'module.smile_cdr_dependencies.helm_release.smilecdr[0]'
   ```

   **Never plan or apply `helm_deploy = false` with the release still in
   state:** Terraform would destroy it, and a Helm uninstall deletes the
   Deployment. **Do not merge the hand-over PR before the `terraform state rm`
   is done:** merged early, it arms that destroy for the next local apply from
   `main`, whoever runs it. The gap the other way round is safe: with the
   release out of state and `main` still on `helm_deploy = true`, an apply
   plans a create, which the Helm provider refuses because the release name is
   in use. A declarative `removed` block does not work here: Terraform refuses
   one while the module still declares the resource (count 0 or not), and the
   module is upstream code. Checked with Terraform 1.15.6 on a throwaway
   module: `removed` fails with "Removed resource still exists"; `state rm`
   followed by count 0 plans no changes.
6. **Merge the hand-over PR**, then from its `main`:
   `terraform plan -var-file=../tfvars/sparkey.tfvars` must show no resource
   changes (only the new output and `helm_release_notes` becoming null). Apply
   it to record the output, then run the `values` check with
   `--terraform-output`; expect `differences: 0`.
7. **Leave the Helm release secrets** (`sh.helm.release.v1.smilecdr.v*`) for 30
   days as the rollback path, then delete them. Argo CD does not track them.
   Leave the `meta.helm.sh/release-*` annotations and the
   `app.kubernetes.io/managed-by: Helm` label on the objects: Argo CD does not
   remove what it did not render, and the import in the rollback needs them.
   While the release secrets exist, `helm uninstall smilecdr` still works and
   deletes every object: nobody runs a Helm command against this release.

One stray ConfigMap is not part of the release
(`smilecdr-scdr-package-au-base-6-1-1-draft-json-02ed8b...`, a leftover of an
earlier revision, still there on 26 Nov). Argo CD does not track it, so it never
prunes it; delete it by hand after the adoption.

## Secrets through ESO (second step, one planned roll, after the event)

Swapping the Secrets Store CSI driver for ESO changes the pod template (volumes
and the image pull secret reference), so it is a pod roll: one Smile restart,
with the old pod serving until the new one is ready. Do it as its own change,
after the event:

- ExternalSecrets in sparked-argo (next to the Application) for the database
  credentials (`smile-SmileCluster-*-sparkey`), `users.json`
  (`smilecdr-users-json`), the token signing keystore
  (`smilecdr-token-signing-jwks`) and the image pull secret (a
  `kubernetes.io/dockerconfigjson` template over `example-key-value`).
- A reader role for the `smile` namespace in `aehrc/sparked-infrastructure`
  (`secrets_readers` in `sparkey-eks/iam.tf`), with `kms:Decrypt` on the
  module's secrets key for the database credentials (the other three use the
  AWS-managed key). The Crossplane-readable prefixes deliberately exclude these
  secrets.
- Chart values switch each secret to `type: k8sSecret` with the ESO-created
  Secret's name, in `values-account.yaml`. The chart supports this for the
  database credentials, image pull secrets, the licence and the generic
  `secrets` block.
- Then remove the SecretProviderClass and the CSI driver dependency for this
  namespace. Rerun the `values` check afterwards: Terraform still injects the
  CSI form, so `values-account.yaml` will differ from it on purpose, and the
  check needs an allowlist for those keys at that point.

## How day-to-day changes work afterwards

- **A config change** is a PR to `module-config/`. Merging it is not yet the
  deploy: the Application goes OutOfSync, and someone syncs it with Prune
  (`argocd app sync smilecdr --prune`, or tick Prune in the UI). Argo CD
  renders a new hashed ConfigMap, the pod template changes, and the pod rolls
  (up to the startup probe's limit, while the old pod serves). With automated
  sync on (after the event), merging is the deploy. The ruleset on `main` (one
  approval) is the review gate.
- **A new mapped file** (package spec or script) is an entry in
  `scripts/render_smile_mapped_files.py` and a run of it.
- **A new generator jar** still needs Terraform first (the `aws_s3_object`),
  then the values PR that points `copyFiles` at it.
- **An IG release** that persists `startup_installation_specs` becomes a values
  PR and a sync, not a local apply.
- **Console edits** are still lost on restart (`PROPERTIES_UNLOCKED`). With
  `selfHeal` on, Argo CD also reverts `kubectl edit` on the Deployment; a
  `kubectl rollout restart` stays (its annotation is never rendered).
- **Chart upgrades** bump the module and `helm_chart_version` here first, then
  `targetRevision` in sparked-argo (see "Keeping the module and the
  Application honest"). Module upgrades that do not touch the chart (Aurora,
  IAM) stay in Terraform and no longer move the workload.

## Freezes

The `smilecdr` Application is in the `sparked` project's event sync window
(sparked-argo `scripts/event-freeze.py`): a `deny` window for the freeze dates
with `manualSync: true`, so an emergency fix can still be synced by hand. While
the Application syncs by hand only, the freeze for Smile is in practice
"nobody presses Sync"; the window is what holds it once `automated` is on, and a
deny window also suspends `selfHeal`. Because Argo CD renders this repository's
`main` at sync time, an emergency sync ships everything merged here since the
last sync: the freeze includes no merges to `module-config/` or `deploy/`, and
an emergency sync starts by reading App Diff. Node expiry on the `on-demand-prod` pool is
a separate control (Karpenter) and is not affected by this change.

## Rollback

- **A bad config change:** `git revert` the PR and sync; Argo CD renders the
  previous hashed ConfigMaps and the pod rolls back. Argo CD's own history
  rollback works too, but only with automated sync off, and git stays the
  record.
Removing the Application never uses `argocd app delete` without
`--cascade=false`, nor the UI's default delete: both delete the Deployment
(see "No resources finalizer" above). The safe way is reverting the
sparked-argo PR: the app-of-apps prune does not cascade, and a revert keeps
`sparked-project-apps` from recreating the Application.

- **During the window, before step 5:** revert the sparked-argo PR. Terraform
  state still owns the release; nothing else changed.
- **Abandoning the migration after step 5:** revert the sparked-argo PR; revert
  the hand-over PR (`helm_deploy = true`);
  `terraform import 'module.smile_cdr_dependencies.helm_release.smilecdr[0]' smile/smilecdr`
  (the Helm release secrets kept in step 7 make this possible). Not rehearsed,
  and weaker than it looks: the Helm provider's import (v3.2.0) records only the
  release's name, chart and status, not its values, so the next plan shows an
  in-place update, a `helm upgrade` to revision 18. That upgrade is clean only
  while the live objects still equal revision 17. After any Argo CD config
  sync, the new hashed ConfigMaps lack Helm's ownership metadata, and the
  upgrade fails with "invalid ownership metadata" until each is labelled
  `app.kubernetes.io/managed-by=Helm` and annotated
  `meta.helm.sh/release-name=smilecdr` and `meta.helm.sh/release-namespace=smile`.
  Read that plan as closely as any other.

## Open questions, answered (26 Nov 2026)

1. **Commit the S3 bucket name, or keep `copyFiles` private?** Committed
   (above). The name is not a credential and was already public in this
   repository.
2. **Does Argo CD skip the chart's `helm.sh/hook: test` Pod?** Yes. In Argo CD
   3.6.2, `gitops-engine/pkg/sync/hook/hook.go` treats any object with a
   `helm.sh/hook` annotation as a hook, and `hook/helm/type.go` maps only
   `pre-install`, `pre-upgrade`, `post-install` and `post-upgrade` to sync
   phases, so a `test` hook has no phase and is never applied or diffed. The
   Application also sets `helm.skipTests: true`, so it is not rendered at all.
3. **`helm.fileParameters` with a `$values` path in a multi-source
   Application?** Supported in 3.6.2 (`getReferencedSource` in the repo
   server's `helmTemplate`). Not used, for the reasons above.
4. **Who holds the `argocd` login for the adoption sync?** Argo CD logs in
   through Keycloak (realm `aehrc`, client `argocd`); `argocd-rbac-cm` grants
   `role:admin` to group `argocd-admin` and sync to group `argocd-developer`;
   everyone else is read-only. Kyle's group membership is unverified from here:
   check with `argocd login argo.sparked-fhir.com --sso` before the window.
   Without the CLI, the UI's Sync button, or the `kubectl patch` of
   `operation` in sparked-argo `docs/event-freeze.md` (Emergencies) with
   cluster-admin kubectl, does the same.
5. **Delete the disabled `smile-application.yml` workflow and its variables?**
   Yes. It never ran for this stack after the repository went public (both jobs
   `if: false`), the OIDC role it assumed no longer exists, and the rollback is
   a local `terraform import`, not CI. The hand-over PR deletes the file; the
   four repository variables only it reads (`CDR_REGCRED_SECRET_ARN`,
   `S3_BUCKET`, `SMILECDR_IAM_ROLE_NAME`, `TF_STATE_BUCKET`) are deleted after it
   merges. `SMILECDR_IAM_ROLE_NAME` still names the destroyed dedicated
   cluster's role.
