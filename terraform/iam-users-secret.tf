# Workaround: Grant IAM permissions for the users-json secret
# The smile-cdr-deps module has a bug where extra_secrets with existing_arn
# don't get added to the IAM policy automatically

data "aws_caller_identity" "current" {}

# The keystores.json seed secret, only when this deployment supplies one. See
# scripts/generate_token_signing_keystore.py for why it exists.
data "aws_secretsmanager_secret" "token_signing" {
  count = var.token_signing_secret_name == null ? 0 : 1
  name  = var.token_signing_secret_name
}

data "aws_iam_policy_document" "users_secret_access" {
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    # The CSI driver reads these as the pod's IRSA identity, so both secrets have
    # to be listed here or the mount fails and the pod never starts.
    resources = concat(
      [data.aws_secretsmanager_secret.smilecdr_users_json.arn],
      data.aws_secretsmanager_secret.token_signing[*].arn
    )
  }

  # Also need KMS decrypt permission for the secret
  statement {
    effect = "Allow"
    actions = [
      "kms:Decrypt"
    ]
    resources = [
      # The secret uses the default AWS managed key
      "arn:aws:kms:${var.region}:${data.aws_caller_identity.current.account_id}:key/*"
    ]
  }
}

resource "aws_iam_policy" "users_secret_access" {
  # IAM policy names are account-global, so two deployments both called "smile"
  # would collide here with EntityAlreadyExists. Carrying the same suffix the
  # module puts on its own generated names keeps them apart, and keeps this
  # resource named consistently with them.
  #
  # No-op for the original deployment: its resourcenames_suffix is null (the
  # module randomises internally), so the name stays smile-users-secret-access.
  name        = "${var.name}-users-secret-access${var.resourcenames_suffix != null ? "-${var.resourcenames_suffix}" : ""}"
  description = "Allow SmileCDR to access users.json secret"
  policy      = data.aws_iam_policy_document.users_secret_access.json
}

resource "aws_iam_role_policy_attachment" "users_secret_access" {
  # Either pinned via var.smilecdr_iam_role_name or reconstructed from the
  # module's naming convention; see local.smilecdr_iam_role_name in main.tf.
  role       = local.smilecdr_iam_role_name
  policy_arn = aws_iam_policy.users_secret_access.arn

  lifecycle {
    precondition {
      condition     = var.smilecdr_iam_role_name != null || var.resourcenames_suffix != null
      error_message = <<-EOT
        Set either smilecdr_iam_role_name (to attach to an existing role) or
        resourcenames_suffix (so the module's generated role name is
        deterministic and can be reconstructed). With both null the role name
        cannot be known before apply.
      EOT
    }
  }
}