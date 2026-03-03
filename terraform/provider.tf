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
      version = ">= 6.8.0, < 7.0.0"  # Module requires >= 6.8.0
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 3.0.0, < 4.0.0"  # Module requires >= 3.0.0
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.38.0, < 3.0.0"  # Module requires >= 2.38.0
    }
  }
  backend "s3" {
    # Configure via: terraform init -backend-config=backend.hcl
    region = "ap-southeast-2"
    key    = "infra/smile-app/prod.tfstate"
  }
}