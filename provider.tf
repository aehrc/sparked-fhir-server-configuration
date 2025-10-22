provider "aws" {
  region = var.region
  # profile = "FHIR-Admin"
}

provider "helm" {

  kubernetes {
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
      version = ">= 5.60.0, < 7.0.0"  # Allow any 5.x or 6.x version
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.10"
    }
  }
  backend "s3" {
    bucket = "examplebucket-fhir-aws"
    region = "ap-southeast-2"
    key    = "infra/smile-app/prod.tfstate"
    # profile = "FHIR-Admin"
  }
}