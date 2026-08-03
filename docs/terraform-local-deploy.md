# Terraform local deploy runbook

How to plan and apply the Sparked Smile CDR infrastructure from a workstation.

> **This document covers the deployment on the dedicated `sparked-smilecdr`
> cluster.** For the parallel deployment on the shared `sparkey` cluster, see
> [sparkey-deploy-runbook.md](sparkey-deploy-runbook.md). The two use separate
> state keys and separate tfvars, and `terraform init -reconfigure` selects
> between them.

**Terraform is applied locally, not in CI.** The `Smile Configuration Deployment`
workflow (`.github/workflows/smile-application.yml`) is intentionally disabled: running
`terraform plan`/`apply` against live infrastructure in a public repository would publish
plan output (secret ARNs, resource IDs, topology) to PR comments, job summaries,
artifacts, and run logs. All real deploys are done from a workstation with the gitignored
`terraform/backend.hcl` and `terraform/terraform.tfvars`.

For a one-off recovery from module or provider drift (version bumps, resource
replacements, state surgery), use [`../terraform/REMEDIATION.md`](../terraform/REMEDIATION.md)
instead; this document covers the normal, steady-state deploy.

## Prerequisites

- **Terraform** `1.15.6` (the `smile_cdr_dependencies` module requires `>= 1.14.3, < 2.0.0`;
  the root `provider.tf` only pins `>= 1.5`, but the module constraint is the binding one).
- **AWS credentials** for the Sparked AWS account (region `ap-southeast-2`), typically via
  AWS SSO with admin access. Confirm with `aws sts get-caller-identity`.
- **The two gitignored config files present in `terraform/`** with real values (see one-time
  setup below):
  - `backend.hcl`, the S3 state bucket name **and the state key**. This deployment uses
    `infra/smile-app/prod.tfstate`. The key used to be hardcoded in `provider.tf` and moved
    into the backend config when a second deployment was added, so that initialising the
    wrong one cannot silently attach to live production state. If `terraform init` prompts
    interactively for `key`, you passed no `-backend-config`: stop rather than typing a value.
  - `terraform.tfvars`, the no-default variables: `s3_bucket_name` and
    `cdr_regcred_secret_arn`, plus `smilecdr_iam_role_name` pinned to
    `smile-smilecdr-dff66d5832d6f1c8` for this deployment. That variable is optional now
    (it defaults to null and is otherwise reconstructed from the module's naming
    convention), but keep it set here: this deployment's role name carries a random suffix
    that predates `resourcenames_suffix`, so it cannot be reconstructed.
- **kubectl** (optional, for verification only). Terraform authenticates to EKS through the
  module's data sources, so it ignores your local kubectl context. For direct `kubectl`
  against the cluster, use `--context sparked-smile`.

## One-time setup

```bash
cd terraform
cp backend.hcl.example backend.hcl              # set the real state bucket name (key is already in the example)
cp terraform.tfvars.example terraform.tfvars    # set s3_bucket_name, cdr_regcred_secret_arn, smilecdr_iam_role_name
terraform init -reconfigure -backend-config=backend.hcl
```

Both files are gitignored (`.gitignore`) and must never be committed.

## Normal deploy

### 1. Take a safety snapshot

Aurora cannot be downgraded and some changes cascade to database resources. Before any
apply, snapshot the Smile Aurora cluster and wait until it is `available`:

```bash
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier <smile-aurora-cluster-id> \
  --db-cluster-snapshot-identifier smile-pre-apply-$(date +%Y%m%d-%H%M) \
  --region ap-southeast-2
```

Pick a low-usage window; brief downtime is acceptable (the server is used mainly during events).

### 2. Init and plan

```bash
cd terraform
terraform init -backend-config=backend.hcl   # re-run after module/provider changes; add -upgrade to bump
terraform plan -out main.tfplan
```

### 3. Review the plan

Read the plan before applying. The bar for a steady-state change is:

- **Zero destroys**, and only the in-place changes you intended.
- No Aurora engine version change (Aurora cannot downgrade; if you see one, stop and reconcile).
- No replacement of the KMS secrets alias or the `smilecdr-users-json` / DB-user secrets.

If the plan shows unexpected destroys or replacements, do not apply. That is drift; follow
[`../terraform/REMEDIATION.md`](../terraform/REMEDIATION.md).

### 4. Apply

```bash
terraform apply main.tfplan
```

### 5. Verify

```bash
# Both nodes serve their CapabilityStatement
curl -sf https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata > /dev/null && echo "aucore ok"
curl -sf https://smile.sparked-fhir.com/ereq/fhir/DEFAULT/metadata   > /dev/null && echo "ereq ok"
```

Ingress body-size cap (expect `403`/`413` around the 16 MiB limit; anonymous, non-persisting):

```bash
for kb in 1100 15000 17000; do
  b=$((kb*1024))
  python3 -c "import sys;sys.stdout.write('{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"_pad\":\"'+'x'*($b-60)+'\"}')" > /tmp/pb.json
  curl -s -o /dev/null -w "${kb}KB -> %{http_code}\n" -m 120 -X POST \
    -H "Content-Type: application/fhir+json" --data @/tmp/pb.json \
    https://smile.sparked-fhir.com/ereq/fhir/DEFAULT
done
# Expect: 1100KB and 15000KB -> 403 (through nginx), 17000KB -> 413 (over the 16 MiB cap)
```

Also confirm the auth flows still work: `client_credentials` for the
`consultmed-ereq-backend` client, and the `smart_auth` interactive login flow.

If verification fails, roll back (below).

## Rollback

1. Restore the Aurora cluster from the pre-apply snapshot taken in step 1.
2. Revert the offending change in the repo (for a module or provider version change, revert
   the pinned ref) and re-`apply` the previous good plan.
3. If an ingress annotation was lost, reapply it out of band, for example:
   ```bash
   kubectl --context sparked-smile -n smile annotate ingress smilecdr-scdr \
     nginx.ingress.kubernetes.io/proxy-body-size=16m --overwrite
   ```

## Notes

- Terraform authenticates to EKS via `module.smile_cdr_dependencies.eks_cluster.*`, so the
  repo's kubectl-context hook warning is a false alarm for terraform runs.
- Provider constraints are driven by the module (`v9.0.2`): aws `>= 6.28.0`, helm `>= 3.1.1`,
  kubernetes `>= 3.0.1`. If you bump the module, re-run `terraform init -upgrade` and update
  `provider.tf` to match `.terraform/modules/.../versions.tf`.
- The fork-safe `Validate Terraform` CI job runs `terraform fmt`/`validate` (no backend, no
  credentials) on pull requests, so syntax and formatting are checked before you plan locally.
