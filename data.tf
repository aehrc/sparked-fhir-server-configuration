

## EKS Cluster auth
data "aws_eks_cluster" "cluster" {
  name = var.cluster_name
}
data "aws_eks_cluster_auth" "cluster_auth" {
  name = var.cluster_name
}
data "aws_iam_openid_connect_provider" "this" {
  url = data.aws_eks_cluster.cluster.identity[0].oidc[0].issuer
}

data "aws_secretsmanager_secret_version" "smilecdr-user-passwords" {
  secret_id = "smilecdr-user-passwords"
}