provider "aws" {
  region = var.region
  # profile = "FHIR-Admin"
}

provider "helm" {
  kubernetes = {
    host                   = module.smile_cdr_dependencies.eks_cluster.endpoint
    cluster_ca_certificate = base64decode(module.smile_cdr_dependencies.eks_cluster.certificate)
    token                  = module.smile_cdr_dependencies.eks_cluster.auth_token
  }
}

provider "kubernetes" {
  host                   = module.smile_cdr_dependencies.eks_cluster.endpoint
  cluster_ca_certificate = base64decode(module.smile_cdr_dependencies.eks_cluster.certificate)
  token                  = module.smile_cdr_dependencies.eks_cluster.auth_token
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