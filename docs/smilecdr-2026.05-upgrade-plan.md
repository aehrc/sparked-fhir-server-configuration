# Smile CDR 2026.05 upgrade plan

Upgrade the Sparked FHIR server from Smile CDR `2025.11.R02` (Helm chart `7.1.0`) to
`2026.05.R01` (Helm chart `9.0.2`), with a verifiable, two-phase rollout and rollback
paths at each step.

Three version levers are involved, and they are deliberately decoupled:

1. Terraform module ref (`?ref=` in `terraform/main.tf`): the `sdh-deps` module code
   that creates AWS resources and drives the helm release. Already at `v9.0.2` and
   staying there (see below).
2. `helm_chart_version` (`terraform/main.tf`): the smilecdr chart the module installs.
   This is what the upgrade bumps to `9.0.2`.
3. `cdrVersion` (`module-config/values-common.yaml`): the Smile CDR application/image
   version. Pinned so a chart bump cannot silently change the running release; bumped
   separately to `2026.05.R01`.

Reference docs:

- Chart upgrade guide: <https://smilecdr-public.gitlab.io/smile-dh-helm-charts/v9.0/upgrading/>
- Chart migration guides: <https://smilecdr-public.gitlab.io/smile-dh-helm-charts/v9.0/upgrading/migration-guides/>
- Smile CDR upgrade guide: <https://smilecdr.com/docs/installation/upgrading.html>
- Smile CDR changelog: <https://smilecdr.com/docs/welcome/changelog.html>

## Current vs target state

| Component | Current | Target |
|---|---|---|
| Smile CDR | 2025.11.R02 (`cdrVersion` in `module-config/values-common.yaml`) | 2026.05.R01 |
| Helm chart | smilecdr 7.1.0 (`helm_chart_version` in `terraform/main.tf`) | smilecdr 9.0.2 |
| Terraform module | `sdh-deps` at `ref=v9.0.2` | unchanged (v9.1.x/v9.2.0 are broken for us, see below) |
| Message broker | Embedded ActiveMQ (chart default, no Kafka) | unchanged |
| Ingress | nginx-ingress, explicitly pinned via `ingress_config` | unchanged |
| Database | Aurora Postgres Serverless v2, engine 14.20 | unchanged |

## Investigation findings

### Version compatibility

- Chart v9 supports Smile CDR `2025.05.R01` through `2026.05.R01`. Chart `9.0.2`
  defaults to (`appVersion`) `2026.05.R01`. This means the chart can be upgraded first
  while `cdrVersion` stays pinned at `2025.11.R02`, isolating the chart hop from the
  application hop.
- Chart target is `9.0.2`, not the newest `9.2.0`: the terraform module was pinned to
  `v9.0.2` (commit `348bbf5`) because module `v9.1.x`/`v9.2.0` carry an upstream
  `_copy_files_node_overlay` type error that breaks `terraform plan` for any
  multi-node deployment, which this is. The bug is still present at `v9.2.0` (checked
  2026-07-14; no newer tag exists). Keeping the module and chart on the same tag is
  the combination upstream actually tests. Chart-side, `9.0.2` vs `9.2.0` was render
  diffed with the live values: the only difference is additive
  `SMILECDR_BASE_URL`/`SMILECDR_NODE_ID` env vars in `9.1+`, so nothing of value is
  lost by staying on `9.0.2`.
- Smile CDR upgrade policy: "Smile CDR can only be upgraded by two quarterly generally
  available releases at a time, e.g. 2023.11 to 2024.05" (online mode). Our jump
  2025.11 to 2026.05 is exactly two GA releases, so it is within the supported window
  and no intermediate stop at 2026.02 is required. Offline upgrades have no window
  limit at all, and with `replicaCount: 1` per node every rollout is effectively a
  brief offline upgrade anyway.
- PostgreSQL: 2026.05 supports v12 and above (v16 recommended). Aurora 14.20 remains
  supported. A later Aurora 14 to 16 upgrade is worth considering but is out of scope
  here.
- Chart 9.1.x and 9.2.0 minor releases only add features chart-side (mostly Azure/AKS
  and DNS passthrough), but their terraform module releases are unusable here per the
  `_copy_files_node_overlay` bug above. Revisit once upstream ships a fixed tag.

### Chart migration guides: what applies to us

- v7 to v8 breaking change: default ingress type on EKS changed from `nginx-ingress`
  to `aws-lbc-gwapi` (Gateway API). Does not bite: `terraform/main.tf` explicitly sets
  `ingressType = "nginx-ingress"` with `useDefaultIngress = true`. Note the guide
  marks nginx-ingress retention as deprecated, so a Gateway API migration should be
  planned eventually (separate piece of work).
- v8 to v9 breaking change: Strimzi-managed Kafka moved to KRaft/KafkaNodePool and
  requires Strimzi operator 1.0.0 or later, with deprecated `messageBroker.strimzi.*`
  values shapes now failing the render. Does not apply: this deployment uses the
  embedded ActiveMQ broker (chart default, confirmed in the rendered
  `Master.properties`) and runs no Strimzi operator.
- `ingresses.default.useLegacyResourceSuffix` (default `true` in v7) is deprecated and
  disabled in v9. We never set it, so the only effect is the Ingress resource rename
  described below.

### Render diff evidence (chart 7.1.0 vs 9.0.2, live values)

Both chart versions were rendered offline with `helm template` using the exact values
of the live release (`helm get values smilecdr -n smile`), for both
`cdrVersion: 2025.11.R02` and `2026.05.R01` (chart 9.2.0 was also rendered and
matches 9.0.2 apart from the additive env vars noted above). All renders succeed (no
deprecated values failures). Diffing the 7.1.0 and 9.0.2 manifests:

- The only resource added, removed, or renamed across the whole release:
  `Ingress smilecdr-scdr` becomes `Ingress smilecdr-scdr-default`. The spec is
  byte-identical (same class, host, annotations, and 18 paths; no TLS block, TLS
  terminates upstream of the nginx controller). Helm deletes the old Ingress and
  creates the new one in the same apply; the nginx controller reconciles in seconds.
- Deployments gain `SMILECDR_BASE_URL`, `SMILECDR_NODE_ID`, `JS_SMILECDR_BASE_URL`,
  `JS_SMILECDR_NODE_ID` env vars, and the S3 `copyFiles` init container is reworked
  from a raw `aws s3 cp` args list to a mounted `filecopy.sh` script (aws-cli image
  2.13 to 2.33). Same jars end up in `customerlib`.
- The rendered `cdr-config-Master.properties` is functionally identical per node (one
  property reordered, whitespace normalisation only).
- The ConfigMap content hash changes, so all three node Deployments roll once per
  phase. With one replica per node that is a short outage per node, as with any config
  change today.

### Smile CDR application changes 2025.11 to 2026.05

- 2026.02: a "case-sensitive FHIR ID" database migration lands. It is flagged as
  breaking zero-downtime only for a subset of SQL Server users; on Postgres it is a
  regular (potentially long-running on large data) migration. All three nodes run
  `db.schema_update_mode = UPDATE` for both clustermgr and persistence, so migrations
  execute at first boot on the new version. Our datasets are small, so expect minutes,
  not hours. Also in 2026.02: Mongo persistence deprecated (not used), Java API class
  renames (only relevant to custom Java, see AUPS risk below).
- 2026.05: GraalVM JavaScript environments are locked down. Scripts may no longer
  instantiate arbitrary Java types (allow-listing required) or read arbitrary files
  from disk. `module-config/smart-post-authorize.js` was audited against this: it only
  uses the injected API objects (`theUserSession`, `theAuthorizationRequestDetails`,
  `Log`, `Converter`, `JSON`), no `Java.type()` and no file access, so it should be
  unaffected. SMART flows are still an explicit verification item.
- 2026.05: Camel 4.10 to 4.18 (kebab-case route names dropped), MDM/MongoDB breakage,
  JWK validation priority changes. None used by this deployment.

### Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AUPS generator jars break against 2026.05 HAPI internals | Medium | `$summary` (AU Patient Summary) fails on aucore/ereq | The jars (`hapi-aups-generator` 1.0.1 on aucore, 0.1.0-alpha on ereq, 1.0.0 on hl7au) extend `ca.uhn.fhir.jpa.ips.jpa.DefaultJpaIpsGenerationStrategy` and other HAPI JPA IPS internals that move between HAPI releases. Smoke test runs `$summary` on both nodes immediately after phase 2; if it fails, rebuild the jars in `aehrc/sparked-fhir-operations` against the 2026.05 HAPI version and bump the S3 artifacts. FHIR CRUD is unaffected either way |
| `smart-post-authorize.js` hits the new GraalVM sandbox | Low | SMART EHR/standalone launch token issuance fails | Script audited clean (no Java instantiation, no file reads). Verify an authorization-code login and a client_credentials token after phase 2 |
| Case-sensitive FHIR ID migration runs long or fails at boot | Low | Node stays unready after phase 2 | Small DB; watch pod logs for migration progress on first 2026.05 boot. Aurora snapshot taken beforehand is the recovery path |
| Ingress rename causes a routing gap | Low | Seconds of 404s at most | Old and new Ingress swap within one helm apply; the nginx controller reconciles quickly. Verify all context paths right after phase 1 |
| 2026.05.R01 image not pullable with our registry credentials | Low | Pods stuck in ImagePullBackOff, old pods keep serving until then | Rollout is RollingUpdate; a pull failure leaves the old ReplicaSet serving. Revert the PR if entitlement is missing |

## Upgrade plan

Both phases ship as ordinary PRs through the existing pipeline: the `Smile
Configuration Deployment` workflow posts the terraform plan on the PR, and apply is a
manually confirmed `workflow_dispatch` (type `APPLY`) after merge.

### Phase 0: preparation (no changes)

1. Pick a quiet window and give connectathon participants notice; each phase rolls all
   three nodes (about 2 to 5 minutes of downtime per node, sequential).
2. Take a manual Aurora cluster snapshot of `SmileCluster` (console or
   `aws rds create-db-cluster-snapshot`). This is the phase 2 rollback anchor.
3. Capture a baseline: `./scripts/upgrade_smoke_tests.sh -o baseline.md` and keep the
   output. It records per-node/per-tenant software versions, resource counts, and
   endpoint health to compare after each phase.

### Phase 1: chart 7.1.0 to 9.0.2, Smile CDR unchanged

One PR changing a single line in `terraform/main.tf` (the module ref stays `v9.0.2`):

```hcl
helm_chart_version = "9.0.2"
```

`cdrVersion` stays `2025.11.R02` in `values-common.yaml`, so this phase changes
Kubernetes packaging only, with the application config proven identical by the render
diff.

Expected plan/apply surface: Ingress rename, Deployment env/init-container changes,
ConfigMap hash roll. Expected NOT to appear: any change to RDS, IAM, Route53, or the
CDR properties.

After apply: run the smoke tests, expect all green with version still 2025.11.R02, and
confirm the new Ingress `smilecdr-scdr-default` serves all paths.

Rollback: revert the PR and re-apply. No data or schema involvement.

### Phase 2: Smile CDR 2025.11.R02 to 2026.05.R01

One PR changing `module-config/values-common.yaml` only:

```yaml
cdrVersion: "2026.05.R01"
```

On apply, pods roll onto the `docker.smilecdr.com/smilecdr:2026.05.R01` image and each
node runs its schema migrations at boot (`schema_update_mode: UPDATE`), including the
2026.02 case-sensitive FHIR ID migration and the 2026.05 set.

During apply, watch first boot on each node:

```bash
kubectl logs -n smile -l app.kubernetes.io/name=smilecdr -f | grep -iE "migrat|flyway|schema|ERROR"
```

After apply: run the full smoke suite with the version assertion,
`./scripts/upgrade_smoke_tests.sh --expect-version 2026.05.R01 -o phase2.md`, then the
manual checks below.

Rollback: Smile CDR processes are designed to run against a schema up to two versions
ahead, so the fast path is reverting `cdrVersion` to `2025.11.R02` and re-applying.
The full path (if the migrated schema itself misbehaves) is restoring the phase 0
Aurora snapshot and reverting the PR. Either way, take the decision before new
clinical data accumulates on the upgraded schema.

## Verification

### Automated: scripts/upgrade_smoke_tests.sh

Baseline run 2026-07-14 against 2025.11.R02: 30 passed, 1 failed. The single failure
is pre-existing and unrelated to the upgrade: `hl7au` returns 404 for its whole
`smartauth` context path (OIDC discovery included), i.e. the SMART outbound security
module is not actually live on that node despite being configured in
`simplified-multinode.yaml`. Expect the same single failure after each phase; treat
any NEW failure as an upgrade regression. The hl7au smartauth gap is tracked as a
follow-up.

Run before phase 1 (baseline), after phase 1, and after phase 2. Read-only by default;
admin credentials come from AWS Secrets Manager at runtime (same pattern as the phase 0
multitenancy tests). Checks per node (aucore, hl7au, ereq) and per ereq tenant
(DEFAULT, SCENARIO-EREQ-MEDS, VENDOR-DEMO):

- `metadata` returns 200 and reports the expected Smile CDR version
  (`--expect-version` makes a mismatch a failure).
- SMART discovery: `.well-known/smart-configuration` on the FHIR endpoint and the
  OIDC `openid-configuration` on the smartauth endpoint.
- Data integrity: Patient and StructureDefinition counts per node/tenant, compared
  against the baseline run by eye (counts are printed side by side in the results
  file).
- IG seeding: the AU Core patient profile StructureDefinition resolves on aucore.
- Request validation still rejects an invalid resource (`$validate`).
- Ingress body-size limit: a padded ~3 MiB `$validate` request must not return
  HTTP 413.
- AUPS generation: `Patient/{id}/$summary` on aucore DEFAULT and ereq
  SCENARIO-EREQ-MEDS returns a document Bundle (the custom generator risk).
- `--write` additionally does a create/read/delete round-trip with a tagged test
  Patient (off by default).

### Manual checks after phase 2

1. SMART authorization-code login with a demo user against
   `ereq/smartauth` (the multitenancy demo flow), confirming the issued token carries
   the Practitioner `fhirUser` claim, which exercises `smart-post-authorize.js` under
   the new GraalVM sandbox.
2. Admin console loads at `/aucore/console` and modules show green.
3. OpenTelemetry: traces/metrics still arriving in the monitoring stack (the agent is
   injected by the operator, independent of the CDR version, but the
   instrumented Kafka/HL7v2 method names in `OTEL_INSTRUMENTATION_METHODS_INCLUDE`
   should be spot-checked for renames if traces go quiet).
4. Skim `kubectl logs` on each node for new WARN/ERROR patterns.

## Out of scope / follow-ups

- Gateway API migration off nginx-ingress (v8 guide marks nginx retention as
  deprecated). Plan separately.
- Aurora Postgres 14 to 16 upgrade (16 is the recommended version for 2026.05).
- Rebuild of the AUPS generator jars against 2026.05 HAPI: only if `$summary` breaks.
- Move module and chart to 9.1+/9.2+ once upstream fixes the
  `_copy_files_node_overlay` plan error for multi-node deployments.
- hl7au smartauth context path returns 404 (SMART outbound module not live on that
  node); pre-existing, investigate separately.
