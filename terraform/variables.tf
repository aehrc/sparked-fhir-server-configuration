

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
  description = "The IAM role name for the SmileCDR service account"
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
