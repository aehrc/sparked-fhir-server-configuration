# CI deploy enablement, scope of work

Goal: get the `Smile Configuration Deployment` workflow (`.github/workflows/smile-application.yml`)
to reliably plan on PRs and apply on merge to `main`, replacing local `terraform apply`.

Status as of 2026-07-11: the workflow is `disabled_manually` and **has never successfully
applied for this stack**. All real deploys to date have been local. Enabling it as-is would
fail. This document scopes the work to make it actually deploy. It is analysis only, nothing
here changes the pipeline yet.

## How the pipeline is designed to work

`smile-application.yml` is a thin caller of two reusable workflows in `aehrc/sparked-infrastructure`:

- `template-terraform-plan.yml@main` runs on PRs (plan only) and on push to `main`.
- `template-terraform-apply.yml@main` runs only on push to `main` when the plan reports changes
  (`tfplanExitCode == 2`), and applies the exact plan artifact produced by the plan job.

Good properties already in place:

- AWS auth is OIDC (`vars.AWS_OIDC_ROLE_ARN = arn:aws:iam::471112546300:role/github-actions-eks-role`),
  no static credentials.
- Apply consumes the plan job's `main.tfplan` artifact, so there is no plan/apply drift.
- Apply is intended to be gated by a GitHub Environment (`infra-apply`, "required reviewers").
- Runners are self-hosted ARC (`arc-runner-set`) on the `sparkey` cluster, with a `CI_RUNNER`
  repo-var escape hatch to fall back to `ubuntu-latest`.
- Init does not use `-upgrade`; it respects the committed `.terraform.lock.hcl`.

## Blockers (must fix before enabling)

1. **Root workflow is out of sync with the template.** The template now requires a `stack_name`
   input; `smile-application.yml` does not pass it, so the reusable-workflow call fails validation.
   Fix (this repo): add `stack_name: smile-app-prod` to both job `with:` blocks.

2. **CI cannot reach the state backend.** The `backend "s3"` block only sets `region` + `key`; the
   **bucket** lives in `terraform/backend.hcl`, which is gitignored (`.gitignore:38`). The template
   runs `terraform init ${{ inputs.init_args }}` and the root workflow passes no `init_args`.
   Fix (this repo): add a repo variable (e.g. `TF_STATE_BUCKET`) and pass
   `init_args: -backend-config="bucket=${{ vars.TF_STATE_BUCKET }}"`.

3. **CI has no variable values.** `terraform.tfvars` is gitignored (`.gitignore:14`); the required
   vars `cdr_regcred_secret_arn`, `s3_bucket_name`, `smilecdr_iam_role_name` have no defaults.
   The template passes no `-var-file`/`TF_VAR_*`. Plan fails on missing vars.
   Note: none of these three are secrets (a Secrets Manager ARN, a bucket name, an IAM role name),
   so repo variables are acceptable. `additional_args` is only consumed by the plan job; apply uses
   the artifact, so the vars only need to be present at plan time.
   Fix (this repo): add repo variables and pass
   `additional_args: -var="s3_bucket_name=${{ vars.S3_BUCKET }}" -var="cdr_regcred_secret_arn=..." -var="smilecdr_iam_role_name=..."`.
   Alternative (cleaner, cross-repo): have the reusable template fetch `backend.hcl` + `terraform.tfvars`
   from SSM Parameter Store before init, so consumers pass nothing sensitive through workflow args.

4. **CI Terraform is too old.** Both templates pin `terraform_version: '1.13.4'`; the v9.0.2 module
   requires `>= 1.14.3` (we run 1.15.6 locally). `init` fails the version constraint.
   Fix (cross-repo, `aehrc/sparked-infrastructure`): either bump the pinned version to a value that
   satisfies `>= 1.14.3` (check the blast radius, all consumers of these templates) or, preferably,
   add a `terraform_version` input (default kept, consumers override) and set it to `1.15.6` here.

5. **The apply gate does not exist.** The GitHub Environment `infra-apply` is not configured on this
   repo. GitHub auto-creates a missing environment on first use **without** protection rules, so the
   apply would run ungated.
   Fix: create the `infra-apply` environment with required reviewers before enabling apply.

6. **OIDC role permissions unverified.** `github-actions-eks-role` must be able to run the FULL apply:
   S3 state read/write + DynamoDB lock (if used), RDS, KMS, IAM, Secrets Manager, Lambda (invoke +
   manage), Route53, and EKS describe/token. If it is EKS-scoped, apply fails partway.
   Fix: review the role's policy against a real plan's resource set; expand if needed.

## Secondary checks

- `terraform fmt -check -recursive` is a hard gate. Fixed on this branch (was dirty on `main`).
- `tflint --minimum-failure-severity=error` is a gate, run it locally against `terraform/` and clear
  any error-severity findings.
- Confirm the self-hosted ARC runner has egress to the S3 backend and AWS APIs and can assume the
  OIDC role; otherwise set `CI_RUNNER=ubuntu-latest`.

## Sequenced plan

Phase 1, make plan-on-PR green (no apply risk):

1. Update `smile-application.yml`: add `stack_name`, `init_args` (backend bucket), `additional_args` (vars).
2. Add repo variables: `TF_STATE_BUCKET`, `S3_BUCKET`, `CDR_REGCRED_SECRET_ARN`, `SMILECDR_IAM_ROLE_NAME`.
3. Resolve the Terraform version (blocker 4).
4. Ensure `fmt` + `tflint` clean.
5. Open a PR touching `terraform/**` or `module-config/**`; iterate until the plan job is green and
   posts a plan comment. This validates backend + vars + version + lint end to end, with no apply.

Phase 2, enable apply:

6. Create the `infra-apply` environment with required reviewers.
7. Verify the OIDC role can perform the full apply (blocker 6).
8. `gh workflow enable smile-application.yml`.
9. Merge a trivial no-op change; watch plan (exitcode 2) then the gated apply, approve, confirm it
   applies cleanly and the service stays healthy. Keep a human watching the first real run.

Phase 3, operationalize:

10. Add branch protection requiring the plan check to pass before merge.
11. Document the flow (PR = plan, merge = apply) in the README and retire the "apply locally" note.

## Risks / watch-items

- The Terraform-version fix is cross-repo and shared; verify other stacks still work.
- Passing vars via `additional_args` puts their values in workflow logs (acceptable for these
  non-secret values; revisit if any become sensitive).
- The first apply-on-merge is the real test of role permissions and the runner, do it with a
  trivial change, gated, watched, with the pre-apply snapshot pattern still available.
