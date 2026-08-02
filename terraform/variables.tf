

variable "name" {
  type        = string
  description = "The name of the deployment"
  default     = "smile"
}

variable "cluster_name" {
  type        = string
  description = "The name of the EKS cluster"
  default     = "sparked-smilecdr"

}

variable "region" {
  type        = string
  description = "The region in which the resources will be deployed"
  default     = "ap-southeast-2"

}

variable "cdr_regcred_secret_arn" {
  type        = string
  description = "The ARN of the CDR registration credentials secret"
}

variable "s3_bucket_name" {
  type        = string
  description = "The S3 bucket for storing FHIR artifacts"
}

variable "smilecdr_iam_role_name" {
  type        = string
  description = <<-EOT
    The IAM role name for the Smile CDR service account, for the extra
    users.json-secret policy attachment in iam-users-secret.tf.

    Leave null (the default) and it is derived from the module's IRSA output
    instead, which is what a new deployment must do: the module generates the
    role name with a random suffix, so the value cannot be known before the
    first apply. Set it only to pin an existing role, as the original
    dedicated-cluster deployment does.
  EOT
  default     = null
}

variable "resourcenames_suffix" {
  type        = string
  description = <<-EOT
    Fixed suffix for the AWS resource names the sdh-deps module generates (the
    IRSA role, the Aurora cluster, the secrets).

    Null (the default) makes the module use a random_id, which is how the
    original deployment got names like smile-smilecdr-dff66d5832d6f1c8. Leave it
    null there: changing it would rename live resources.

    Set it for a new deployment. It keeps names distinct from the existing ones
    in the same AWS account, and it makes the IRSA role name predictable, which
    is what lets the deployment come up in a single apply.
  EOT
  default     = null
}

variable "db_subnet_group_name" {
  type        = string
  description = <<-EOT
    Name for the RDS DB subnet group this deployment creates. This names a group
    the module CREATES; it is not a reference to an existing one.

    Null (the default) uses the module's generated name. Leave it null on the
    original dedicated-cluster deployment.

    A second deployment in the same account MUST set it. The generated name does
    not carry resourcenames_suffix (it is "<name>-<db instance name>"), so two
    deployments both called "smile" collide on "smile-smilecluster" with
    DBSubnetGroupAlreadyExists. Use a name carrying the same suffix as everything
    else, e.g. "smile-smilecluster-<deployment>".
  EOT
  default     = null
}

variable "token_signing_secret_name" {
  type        = string
  description = <<-EOT
    Name of the AWS Secrets Manager secret holding the Smile CDR keystores.json
    seed document, created by scripts/generate_token_signing_keystore.py.

    Null (the default) leaves the deployment relying on whatever keystore already
    exists in its database, which is the situation on the original
    dedicated-cluster deployment.

    Set it for a deployment built from an empty database, which otherwise cannot
    start smart_auth at all: openid.signing.keystore_id names a keystore that
    nothing in this repository creates. Setting it also requires the matching
    secrets.tokenSigningKeystore mount in an overlay (see
    module-config/values-sparkey.yaml).
  EOT
  default     = null
}

variable "namespace" {
  type        = string
  description = <<-EOT
    Kubernetes namespace for the Smile CDR release. Defaults to "smile" rather
    than being derived from var.name by the module (which uses lower(name)), so
    that a deployment can carry a distinct var.name for AWS resource naming while
    keeping the namespace the GitOps manifests in sparked-argo expect.
  EOT
  default     = "smile"
}

variable "extra_values_files" {
  type        = list(string)
  description = <<-EOT
    Extra Helm values files layered on top of values-common.yaml and
    simplified-multinode.yaml, in order, last wins. Paths are relative to the
    terraform directory.

    Empty for the original dedicated-cluster deployment. The sparkey deployment
    passes ["../module-config/values-sparkey.yaml"].
  EOT
  default     = []
}

variable "manage_ingress" {
  type        = bool
  description = <<-EOT
    Whether this stack's sdh-deps module manages ingress and the Route53 record.

    True (default) is the original deployment: the chart renders an nginx Ingress
    and the module creates the DNS alias.

    False is for a cluster where routing and DNS are owned elsewhere. On sparkey
    the HTTPRoutes are authored in sparked-argo and external-dns creates the
    record from the route hostname, so the module must not also try; its
    gatewayapi path would fail anyway, because it resolves the gateway load
    balancer with the ELBv2-only aws_lb data source and sparkey's Envoy Gateway
    is fronted by a Classic ELB.

    Set false together with an overlay in extra_values_files that sets
    ingresses.default.enabled = false, or the chart will still render one.
  EOT
  default     = true
}

variable "rds_name" {
  type        = string
  description = "The name of the RDS instance"
  default     = "sparked-smile-cdr-postgresql"

}

variable "domain" {
  type        = string
  description = "The domain name for the deployment"
  default     = "sparked-fhir.com"

}
