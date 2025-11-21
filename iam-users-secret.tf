# Workaround: Grant IAM permissions for the users-json secret
# The smile-cdr-deps module has a bug where extra_secrets with existing_arn
# don't get added to the IAM policy automatically

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "users_secret_access" {
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    resources = [
      data.aws_secretsmanager_secret.smilecdr_users_json.arn
    ]
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
  name        = "${var.name}-users-secret-access"
  description = "Allow SmileCDR to access users.json secret"
  policy      = data.aws_iam_policy_document.users_secret_access.json
}

resource "aws_iam_role_policy_attachment" "users_secret_access" {
  role       = "smile-smilecdr-dff66d5832d6f1c8"
  policy_arn = aws_iam_policy.users_secret_access.arn
}