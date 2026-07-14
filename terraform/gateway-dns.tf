# Gateway API migration: DNS for smile.sparked-fhir.com after cutover to Envoy Gateway.
#
# Previously the sdh-deps module created this record aliased to the ingress-nginx NLB
# (ingress_config.public.route53_create_record). That is now false, and this record aliases
# smile.sparked-fhir.com to the Envoy Gateway NLB provisioned by the AWS Load Balancer
# Controller in envoy-gateway-system. The Gateway (main-gateway) is created via GitOps in
# sparked-smile-argo. See docs/gateway-api-migration-plan.md.
#
# Cutover note (gapless): to avoid a brief window where the record is absent, adopt the
# existing record into this resource's state before the first apply rather than letting
# Terraform destroy-then-create it:
#   terraform state mv \
#     'module.smile_cdr_dependencies.aws_route53_record.publicdns["public"]' \
#     'aws_route53_record.smile_public'
# The apply then becomes an in-place alias retarget (nginx NLB -> Envoy NLB). Confirm the
# source address with `terraform state list | grep publicdns` first.

data "aws_route53_zone" "parent" {
  name         = var.domain
  private_zone = false
}

# The Envoy Gateway NLB hostname, read from the Gateway's programmed status. main-gateway is
# stable once PROGRAMMED (status.addresses[0].value is the LBC-managed NLB DNS name).
data "kubernetes_resource" "envoy_gateway" {
  api_version = "gateway.networking.k8s.io/v1"
  kind        = "Gateway"
  metadata {
    name      = "main-gateway"
    namespace = "default"
  }
}

locals {
  envoy_nlb_hostname = data.kubernetes_resource.envoy_gateway.object.status.addresses[0].value
}

resource "aws_route53_record" "smile_public" {
  zone_id = data.aws_route53_zone.parent.zone_id
  name    = "smile.${var.domain}"
  type    = "A"

  alias {
    name = local.envoy_nlb_hostname
    # Regional canonical hosted zone ID for Network Load Balancers in ap-southeast-2
    # (the same value the previous ingress-nginx NLB alias used for this record).
    zone_id                = "ZCT6FZBF4DROD"
    evaluate_target_health = false
  }
}
