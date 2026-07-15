# Terraform Remediation Runbook

Handoff runbook to get the Sparked Smile CDR terraform back to a clean, applyable,
best-practice state, then apply to prod and re-enable CI deploy.

Written 2026-07-10 from a session that diagnosed the drift by running a live `plan`.
See also the project-memory note `deploy-pipeline-state`.

## Goal / definition of done

- `terraform plan` against prod shows **zero destroys and only intended in-place changes**.
- Prod applied and healthy; the ingress 16 MiB body-size limit is codified (no longer a manual annotation).
- The `Smile Configuration Deployment` workflow is re-enabled and the pinned config lands via a reviewed PR.

## Locked decisions

- **Module target: latest released tag `v9.2.0`** (currently pinned to the moving branch `terraform-module`, which drifted to module version 8.1.0; last successful apply was on 7.3.0).
- **Keep `helm_chart_version = "7.1.0"`** for this pass. Fix the terraform-module drift only; do NOT also upgrade Smile CDR itself in the same change (one axis at a time).
- **No non-prod/staging env.** Validate via careful `plan` review only.
- **Brief downtime is acceptable** (server is used mainly during events).
- **Local `terraform apply` until stable**, then move to the pipeline.
- Take an Aurora snapshot before applying.

## Known drift (from the plan on 2026-07-10)

Baseline: `provider.tf` pinned kubernetes `< 3.0.0`, but the drifted module requires `>= 3.0.1`.
After bumping k8s to v3 to init, `plan` = **17 add / 9 change / 16 destroy**, plus a hard error. The problem items:

1. **Aurora engine DOWNGRADE** `14.20 -> 14.15`. The live DB auto-upgraded to 14.20 (`engine_version_actual` confirms); Aurora cannot downgrade. Must reconcile.
2. **KMS secrets alias replacement** `alias/smile-secrets -> alias/smile-secrets-dff66d5832d6f1c8` (forces replacement).
3. **`create_app_user` lambda invocations replaced** for every node (aucore, ereq, hl7au, audit, clustermgr, persistence, transaction) plus their `pg_user_db` `aws_secretsmanager_secret_version` resources.
4. **kubernetes v3 provider error**: `Provider produced null object` for `module...data.kubernetes_resource.gateway["gateway-api"]`. The plan did not complete cleanly.
5. The desired change (ingress `proxy-body-size: 16m`) DOES show correctly as an in-place `helm_release.smilecdr[0]` update, that part is fine.

## Environment / prerequisites

- terraform 1.15.6; AWS SSO admin creds, account `<AWS_ACCOUNT_ID>`, region `ap-southeast-2`.
- `terraform/backend.hcl` and `terraform/terraform.tfvars` are present (real, gitignored). Backend state key: `infra/smile-app/prod.tfstate`.
- Providers target the EKS cluster via module data sources (`module.smile_cdr_dependencies.eks_cluster.*`), so terraform ignores the local kubectl context. For direct `kubectl`, use `--context sparked-smile` (the repo hook's context warning is a false alarm for terraform).
- The live serving ingress is `smile/smilecdr-scdr` (class `nginx`, host `smile.sparked-fhir.com`). The 16 MiB fix is currently a manual out-of-band annotation on it; it is also merged into `module-config/values-common.yaml` (PR #59).

## Procedure

### 0. Safety first
- `aws rds create-db-cluster-snapshot` (or instance snapshot) of the Smile Aurora cluster; wait until `available`.
- Confirm the `smilecdr-users-json` / DB-user secrets are recoverable.
- Pick a low-usage window; expect brief downtime.

### 1. Baseline branch + pin
- `git checkout -b chore/terraform-remediation` off `main`.
- In `terraform/main.tf`, change the module `source` ref from `?ref=terraform-module` to `?ref=v9.2.0`.
- In `terraform/provider.tf`, set provider constraints to what v9.2.0 requires (expect kubernetes `>= 3.0.1, < 4.0.0`; helm already `>= 3.0.0`; aws as required). Read the module's `versions.tf` under `.terraform/modules/...` after init to confirm exact constraints.
- Keep `helm_chart_version = "7.1.0"`.
- `terraform init -upgrade -backend-config=backend.hcl`.

### 2. Drive the plan to non-destructive
Iterate `terraform plan` and resolve each problem item; the goal is zero destroy.

- **engine_version**: find where v9.2.0 exposes the Aurora engine version (module var / rdsinstance submodule). Set it to `14.20` to match the live DB, or add `lifecycle { ignore_changes = [engine_version] }` if the module allows passthrough. Confirm the plan no longer shows a downgrade.
- **KMS alias**: understand the new alias naming in v9.2.0 (the `-dff66d5832d6f1c8` suffix). Prefer a `moved {}` block or `terraform import` / `state mv` so the existing alias is retained rather than replaced (replacing the alias used for secrets is risky). If the module makes the suffix unavoidable, plan the secret re-encryption/rotation deliberately.
- **create_app_user lambdas + pg_user_db secret versions**: determine the replacement trigger (likely `secret_string_wo_version` / input hash changes). Confirm whether re-running rotates live DB passwords that nodes depend on. If it does, coordinate: the nodes read DB creds from these secrets, so a rotation may need a node restart / users.json re-seed. If idempotent, accept.
- **gateway-api data source null**: the repo `ingress_config.public` has no `ingressType`, so it defaults to `gatewayapi`, but the live ingress is nginx (`smilecdr-scdr`). Reconcile `ingress_config` to reality: set `ingressType = "nginx-ingress"` (and confirm this removes the gateway `kubernetes_resource` data source that errors under the v3 provider). This should also make the plan match the live nginx ingress instead of trying to stand up a gateway/ALB one.
- For any remaining replace/destroy, use `moved {}` / `import` to align state with the new module's resource addresses without recreation.

### 3. Codify the ingress body-size fix
- Ensure the `default` (nginx) ingress carries `nginx.ingress.kubernetes.io/proxy-body-size: "16m"` from `values-common.yaml` (already merged) so that after apply the manual annotation is codified and the plan shows no ingress diff.

### 4. Apply to prod (local)
- Re-confirm the snapshot exists.
- `terraform apply` the reviewed plan in the chosen window.
- Verify: pods healthy; aucore + ereq FHIR endpoints return `metadata`; the anonymous size probe returns `403` under 16 MiB and `413` over; token flow works for `consultmed-ereq-backend` (client_credentials) and the smart_auth login flow.

### 5. Stabilize, then re-enable the pipeline
- Once plans are clean and applies are boring, commit the pinned-tag + provider + ingress_config changes and open a PR.
- Re-enable the deploy workflow: `gh workflow enable smile-application.yml`. Note `terraform-apply` in that workflow only runs on `push` to `main` (not `workflow_dispatch`), so a merge to `main` is what triggers a real apply.

## Rollback
- If an apply goes wrong: restore Aurora from the pre-apply snapshot; revert the module `ref` to the previous state; re-apply the ingress `proxy-body-size` annotation manually if needed (`kubectl --context sparked-smile -n smile annotate ingress smilecdr-scdr nginx.ingress.kubernetes.io/proxy-body-size=16m --overwrite`).

## Reusable verification probe (anonymous, non-persisting)
```bash
for kb in 1100 15000 17000; do
  b=$((kb*1024))
  python3 -c "import sys;sys.stdout.write('{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"_pad\":\"'+'x'*($b-60)+'\"}')" > /tmp/pb.json
  curl -s -o /dev/null -w "${kb}KB -> %{http_code}\n" -m 120 -X POST -H "Content-Type: application/fhir+json" --data @/tmp/pb.json https://smile.sparked-fhir.com/ereq/fhir/DEFAULT
done
# Expect: 1100KB and 15000KB -> 403 (through nginx), 17000KB -> 413 (over 16 MiB cap)
```
