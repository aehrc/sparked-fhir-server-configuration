provider "aws" {
  region = var.region
  # profile = "FHIR-Admin"
}

# Cluster auth via `aws eks get-token` at the moment it is needed, NOT a token
# resolved once at plan time.
#
# These used to pass `token = module.smile_cdr_dependencies.eks_cluster.auth_token`,
# which comes from the aws_eks_cluster_auth data source and is valid for 15
# minutes from when the data source is read. That is fine for a steady-state
# apply of a few minutes and fails for a long one. The first sparkey apply died
# on exactly this, after Aurora creation plus a first-boot schema migration had
# taken it past the 15-minute mark:
#
#   Error: Error checking release existence
#   Kubernetes cluster unreachable: the server has asked for the client to
#   provide credentials
#
# The Helm release had already been installed at that point, so the failure left
# it running but absent from state and needing an import. An exec credential is
# re-invoked whenever the provider needs one, so a long apply cannot outlive it.
#
# This mirrors what sparked-infrastructure already does for both cluster stacks;
# see the provider.tf headers there. Requires the AWS CLI on PATH wherever
# terraform runs, which is already a prerequisite of this repo's local-apply
# model.
provider "helm" {
  kubernetes = {
    host                   = module.smile_cdr_dependencies.eks_cluster.endpoint
    cluster_ca_certificate = base64decode(module.smile_cdr_dependencies.eks_cluster.certificate)

    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", var.cluster_name, "--region", var.region]
    }
  }
}

# NOTE the syntax difference from the helm provider above: helm v3 takes `exec`
# as an attribute inside its `kubernetes = { ... }` object, the kubernetes
# provider takes it as a nested BLOCK. Same credential, different shape.
provider "kubernetes" {
  host                   = module.smile_cdr_dependencies.eks_cluster.endpoint
  cluster_ca_certificate = base64decode(module.smile_cdr_dependencies.eks_cluster.certificate)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", var.cluster_name, "--region", var.region]
  }
}

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.28.0, < 7.0.0" # Module (v9.0.2) requires >= 6.28.0
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 3.1.1, < 4.0.0" # Module (v9.0.2) requires >= 3.1.1
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 3.0.1, < 4.0.0" # Module (v9.0.2) requires >= 3.0.1
    }
  }
  backend "s3" {
    # bucket AND key both come from the -backend-config file. Select the
    # deployment at init:
    #
    #   terraform init -reconfigure -backend-config=backend.hcl          # dedicated cluster
    #   terraform init -reconfigure -backend-config=backend-sparkey.hcl  # sparkey
    #
    # The key used to be hardcoded here as infra/smile-app/prod.tfstate. That was
    # fine while there was one deployment and became dangerous once there are two:
    # a second deployment initialised without noticing would attach to the LIVE
    # production state, and its first apply would try to move the running server
    # onto the other cluster. Both keys must now be chosen explicitly.
    #
    # If terraform prompts interactively for "key", you passed no -backend-config.
    # Stop and pass one rather than typing a value.
    region = "ap-southeast-2"
  }
}