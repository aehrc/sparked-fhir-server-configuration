# Smile deploy inputs in AWS Secrets Manager

The Smile CDR stack is applied locally (see
[sparkey-deploy-runbook.md](sparkey-deploy-runbook.md)), and a local apply needs
two gitignored files that used to exist on one workstation only. This page
describes where they are kept instead, who can read them, and how
`scripts/fetch-smile-tfvars.sh` moves them between Secrets Manager and a
checkout.

It is the interim step for "nothing depends on one laptop". The longer-term
plan, moving the Smile workload to an Argo CD Application, is in
[design/smile-to-argo.md](design/smile-to-argo.md) once that lands, and does not
change anything here: Aurora, S3 and IAM stay in Terraform, so these inputs are
still needed afterwards.

## The two files

| Local file (gitignored) | Secret | What it holds |
|---|---|---|
| `tfvars/sparkey.tfvars` | `sparked/smile/terraform/sparkey-tfvars` | `cluster_name`, `name`, `resourcenames_suffix`, `namespace`, `manage_ingress`, `extra_values_files`, `smilecdr_iam_role_name`, `cdr_regcred_secret_arn`, `s3_bucket_name`, `db_subnet_group_name`, `token_signing_secret_name` |
| `terraform/backend-sparkey.hcl` | `sparked/smile/terraform/backend-sparkey-hcl` | `bucket`, `key` for the S3 state backend |

Both secrets hold the file exactly as it is on disk, byte for byte, as a plain
string (not JSON). The committed `.example` siblings show the shape.

Nothing in either file is a credential. They are identifiers: the state bucket,
the image-pull secret's ARN, role and secret names. They are kept out of git
because this repository is public and carries no account ids or secret ARNs,
not because a leak would grant access. That is why the storage below is
deliberately plain.

`terraform/terraform.tfvars`, if you still have one, is a leftover of the
destroyed dedicated-cluster stack. It is not stored and not needed:
`sparkey.tfvars` sets every variable it would set. Terraform still auto-loads it,
so the script prints a note when it finds one.

## Design

**Two secrets, one per file.** Each maps to one file, so `push` uploads the file
with `file://` and the value never passes through the shell or a JSON wrapper,
each file keeps its own version history, and a change to one cannot clobber the
other. One JSON secret holding both would need a read-modify-write on every
push.

**Names under `sparked/smile/terraform/`.** The `sparked/<area>/` prefix matches
the account's other secrets (`sparked/argocd/*`, `sparked/k8s/*`). It is
deliberately outside the prefixes that roles created by Crossplane may read
(`crossplane_readable_secret_prefixes` in
`aehrc/sparked-infrastructure` `sparkey-eks/iam.tf`), so no in-cluster
workload can be pointed at these.

**Encryption: the AWS managed key `aws/secretsmanager`**, the same as every other
non-RDS secret in the account. A customer managed key would only add a second
gate on content that is not a credential, and a key policy narrow enough to
matter is one that can lock everyone out. Revisit if a credential is ever added
to either file.

**Direct reads and writes: the `AdministratorAccess` permission set only.**
Each secret carries a resource policy that denies `GetSecretValue`,
`PutSecretValue`, `UpdateSecret` (which can also write a new value) and
`UpdateSecretVersionStage` (which can point `AWSCURRENT` at an old version) to
every principal whose ARN is not an `AWSReservedSSO_AdministratorAccess_*` role
in this account. Without it, anyone with the `PowerUserAccess` permission set,
and the GitHub Actions apply roles in `aehrc/sparked-infrastructure` (which
hold `AdministratorAccess`), could read and replace them directly.
Administrator is the right line because it is already what an apply needs: the
stack creates and changes IAM roles and policies, which `PowerUserAccess`
cannot do. So "can fetch the inputs" and "can apply Smile" are the same set of
people.

What the policy does not do: it is not a hard boundary. It does not deny
`PutResourcePolicy` or `DeleteResourcePolicy`, so any principal allowed those
actions (an administrator, and also the `PowerUserAccess` set and the
GitHub apply roles) can change or remove the policy first and then read or
write; CloudTrail records that change. That is deliberate. The content is
identifiers, not credentials, so a speed bump with an audit trail is enough,
and it keeps a way back in: the policy can never lock the account out, and the
break-glass and `OrganizationAccountAccessRole` roles, which it denies a direct
read, can remove it if SSO is ever unavailable. Deleting a secret is not denied
either; a deleted secret stays recoverable for its recovery window (7 to 30
days).

**Versioning and rollback come free.** Every `push` is a new secret version;
Secrets Manager keeps the one before it labelled `AWSPREVIOUS`. See
[Undo a push](#undo-a-push).

**Not Parameter Store, not git.** SSM Parameter Store would also do, but the
account keeps everything of this kind in Secrets Manager, and one place to look
is worth more than a second store. Committing the files is ruled out by the
public-repository policy above.

## Daily use

Run from the repository root with credentials for the Sparked account:

```bash
aws sso login --profile csiro-fhir
export AWS_PROFILE=csiro-fhir

scripts/fetch-smile-tfvars.sh            # write both files, mode 0600
scripts/fetch-smile-tfvars.sh status     # compare local files with the stored copies
```

Then follow [sparkey-deploy-runbook.md](sparkey-deploy-runbook.md) from
`terraform init`.

`fetch` refuses to overwrite a local file that differs from the stored copy. If
you changed the local file on purpose, `push` it; if you want the stored copy,
`fetch --force` (it keeps your old copy as `sparkey.bak-<timestamp>.tfvars`,
which `.gitignore` also covers). The script never prints either file.

`fetch` also records, next to each file, the secret version it matched or
wrote (`sparkey.tfvars.secret-version`, mode 0600, gitignored). `push` uses it
to refuse a stale base: if someone else pushed after your fetch, or there is no
record, `push` stops instead of silently reverting their change. Then run
`fetch --force` (your copy is kept as a backup), re-apply your edit to the
fetched file and push again; `push --force` replaces the stored copy
regardless. The check is not a lock: two pushes in the same second can still
race.

### After changing a value

Edit the local file, plan and apply as usual, then store it so the next
operator gets the same inputs:

```bash
scripts/fetch-smile-tfvars.sh status     # shows DIFFERENT for the file you edited
scripts/fetch-smile-tfvars.sh push       # asks before replacing each changed secret;
                                         # refuses if the stored copy moved since your fetch
```

Push after the apply succeeds, not before: the stored copy should describe what
is live.

### Undo a push

Move `AWSCURRENT` back to the previous version:

```bash
SECRET=sparked/smile/terraform/sparkey-tfvars
aws secretsmanager list-secret-version-ids --secret-id "$SECRET" \
  --query 'Versions[].[VersionId,join(`,`,VersionStages),CreatedDate]' --output text
aws secretsmanager update-secret-version-stage --secret-id "$SECRET" \
  --version-stage AWSCURRENT \
  --move-to-version-id <the AWSPREVIOUS version id> \
  --remove-from-version-id <the AWSCURRENT version id>
```

Then `scripts/fetch-smile-tfvars.sh fetch --force`, which also records the
version you moved back to.

## Giving another operator access

They need the `AdministratorAccess` permission set on the Sparked AWS account in
IAM Identity Center, and a profile for it (this repository's docs call it
`csiro-fhir`). Nothing else: no file is passed around, and the resource policy
already admits that permission set. Assignments are made in the organisation's
Identity Center, not in this account.

## First-time setup

Done once, from the workstation that held the files, by someone with the
`AdministratorAccess` permission set. Run from the repository root; the
commands read the files by path and never echo them.

```bash
export AWS_PROFILE=csiro-fhir AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

for pair in "sparked/smile/terraform/sparkey-tfvars=tfvars/sparkey.tfvars" \
            "sparked/smile/terraform/backend-sparkey-hcl=terraform/backend-sparkey.hcl"; do
  name="${pair%%=*}"; file="${pair#*=}"
  aws secretsmanager create-secret --name "$name" \
    --description "Smile CDR local apply input: $file (aehrc/sparked-fhir-server-configuration, docs/smile-deploy-inputs.md)" \
    --secret-string "file://$file" \
    --tags Key=Repository,Value=github.com/aehrc/sparked-fhir-server-configuration Key=Purpose,Value=smile-local-apply \
    --query Name --output text
done
```

Then attach the resource policy to each. It needs `$ACCOUNT` from the block
above. The block runs as one subshell so that, pasted into a fresh shell, the
guard on its first line stops all of it: an empty account id would make a
pattern that matches nobody and deny reads to everyone.

```bash
(
: "${ACCOUNT:?run the block above first, it sets ACCOUNT}"
cat > /tmp/smile-deploy-inputs-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlySsoAdministrators",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:UpdateSecretVersionStage"
      ],
      "Resource": "*",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": "arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*"
        }
      }
    }
  ]
}
EOF
for name in sparked/smile/terraform/sparkey-tfvars sparked/smile/terraform/backend-sparkey-hcl; do
  # validate-resource-policy exits 0 even when the policy fails, so test its answer.
  if [ "$(aws secretsmanager validate-resource-policy --secret-id "$name" \
          --resource-policy file:///tmp/smile-deploy-inputs-policy.json \
          --query PolicyValidationPassed --output text)" = True ]; then
    aws secretsmanager put-resource-policy --secret-id "$name" \
      --resource-policy file:///tmp/smile-deploy-inputs-policy.json --block-public-policy --query Name --output text
  else
    echo "policy failed validation for $name; not attached"
  fi
done
rm /tmp/smile-deploy-inputs-policy.json
)

scripts/fetch-smile-tfvars.sh fetch      # expect "unchanged" for both; records each version
```

If `fetch` now fails with `AccessDeniedException`, the policy does not match
your role. Remove it with
`aws secretsmanager delete-resource-policy --secret-id <name>` (not denied by
the policy) and check the ARN that `aws sts get-caller-identity` reports.
