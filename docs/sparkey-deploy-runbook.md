# Deploy runbook: Smile CDR on the sparkey cluster

Standing up the parallel Smile CDR deployment on the shared `sparkey` cluster,
alongside the live one on `sparked-smilecdr`. Both run at once until DNS cuts
over; this document covers the build, not the cutover.

Background and the decision to consolidate:
`docs/smile-consolidation-evaluation.md` in `aehrc/sparked-infrastructure`
(section 9 is the migration path). For the existing dedicated-cluster
deployment, use [terraform-local-deploy.md](terraform-local-deploy.md).

## What is already in place

Landed on sparkey via `aehrc/sparked-argo` #223 and #224, all verified live:

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

## Prerequisites

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

> **The backend key is no longer in `provider.tf`.** It moved into the
> `-backend-config` file so that a second deployment cannot silently attach to
> live production state. If `terraform init` ever prompts interactively for
> `key`, you passed no `-backend-config`: stop rather than typing a value.

## Deploy

### 1. Init against the sparkey state key

```bash
cd terraform
terraform init -reconfigure -backend-config=backend-sparkey.hcl
```

Confirm before going further:

```bash
terraform state list | wc -l    # expect 0 on the very first run
```

A non-zero count means you are pointed at the wrong state. Stop.

### 2. Plan

```bash
terraform plan -var-file=../tfvars/sparkey.tfvars -out=sparkey.plan
```

Expect roughly **66 to add, 0 to change, 0 to destroy**. Sanity checks worth
making on the plan rather than trusting the count:

- `aws_rds_cluster` identifier is `smile-smilecluster-<deployment>`, engine
  `aurora-postgresql` `16.13`
- security group rules reference sparkey's VPC (`<sparkey-vpc-id>`) and its
  worker-node security group
- the IAM policy is `smile-users-secret-access-sparkey` and the role attachment
  targets `smile-smilecdr-<deployment>`, neither colliding with the live
  `smile-users-secret-access` / `smile-smilecdr-dff66d5832d6f1c8`
- **no `aws_route53_record` resources at all** (external-dns owns DNS here)
- the `helm_release` targets namespace `smile`

### 3. Apply

```bash
terraform apply sparkey.plan
```

The Aurora cluster is the long pole, typically 15 to 20 minutes. The Helm
release then waits on pod readiness; Smile CDR's own startup probe allows up to
30 minutes, so a slow first boot is not a failure.

### 4. Watch the first pod carefully

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

## Seeding

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

## Verify

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

Compare against a baseline captured from the live server the same day.

Also confirm telemetry: the OTLP endpoint
(`k8s-monitoring-alloy-metrics.monitoring.svc.cluster.local:4317`) resolves on
this cluster unchanged, so traces and metrics should appear in sparkey's LGTM
with no config edit.

## Rollback

Nothing to roll back in the sense that matters: the live server is untouched
throughout and keeps serving `smile.sparked-fhir.com`. Abandoning this build is
`terraform destroy -var-file=../tfvars/sparkey.tfvars` against the sparkey state
key, which removes the Aurora cluster, the IAM, the secrets and the release.
The sparked-argo manifests are additive and can stay.

Take a final snapshot before any destroy if the server has been used for
anything worth keeping.

## Known risks

- **Network policies are unvalidated against a running workload.** They were
  derived from the pod on the old cluster. Reconcile from the deny log before
  cutover; rollback is a one-file delete in sparked-argo.
- **Parallel running costs roughly $150 to $200/mo**, mostly the second Aurora
  (min 0.5 ACU when idle) plus one `r6a.large`.
- **Partition seed restart semantics are unverified** (see the multitenancy
  plan). Not exercised by this build.
