module "smile_cdr_dependencies" {
  source                 = "git::https://gitlab.com/smilecdr-public/smile-dh-helm-charts//src/main/terraform/sdh-deps?ref=v9.0.2"
  name                   = var.name
  eks_cluster_name       = var.cluster_name
  cdr_regcred_secret_arn = var.cdr_regcred_secret_arn
  prod_mode              = false

  # Kubernetes namespace, pinned rather than left to the module's lower(var.name)
  # default. Both deployments are called "smile" so the default would give the
  # same answer, but the GitOps HTTPRoutes, network policies and ArgoCD
  # AppProject destination in sparked-argo all hardcode "smile", and that
  # coupling deserves to be visible here rather than implied.
  namespace = var.namespace

  # Fixes the suffix on every generated AWS resource name. Left null (the
  # original deployment) the module uses a random_id, which is why the live
  # resources read smile-smilecdr-dff66d5832d6f1c8 and
  # smile-smilecluster-dff66d5832d6f1c8.
  #
  # The sparkey deployment sets it to a literal, which does two things: it keeps
  # the two deployments' AWS resources distinct while both exist in this one
  # account, and it makes the IRSA role name knowable before the first apply (see
  # local.smilecdr_iam_role_name below), so standing the deployment up is a single
  # pass rather than apply-read-edit-apply.
  resourcenames_suffix = var.resourcenames_suffix
  # Chart 9.0.2 pairs with the module tag above (the module stays on v9.0.2:
  # the v9.1.x/v9.2.0 module releases break plan for multi-node copyFiles, see
  # docs/smilecdr-2026.05-upgrade-plan.md). Chart v9 supports Smile CDR
  # 2025.05.R01 through 2026.05.R01; cdrVersion stays pinned independently in
  # module-config/values-common.yaml.
  helm_chart_version = "9.0.2"

  # The module default is 600s, which is shorter than Smile CDR's own startup
  # probe allows (30 minutes) and too short for a FIRST boot against an empty
  # database, where the pod also runs the full schema migration before it reports
  # ready. A helm timeout there leaves the release in `pending-install` and needs
  # manual cleanup before a retry, which is a worse failure than simply waiting.
  #
  # 1800s matches the startup probe. It changes nothing for an established
  # deployment, where readiness is reached in a couple of minutes.
  helm_chart_timeout = 1800


  # ORDER MATTERS: helm merges these left to right, so a later file overrides an
  # earlier one. Overlays must come last.
  helm_chart_values = concat(
    [
      templatefile("../module-config/values-common.yaml", { s3_bucket = var.s3_bucket_name }),       #core - required
      templatefile("../module-config/simplified-multinode.yaml", { s3_bucket = var.s3_bucket_name }) # per-node copyFiles reference the bucket
    ],
    # Per-deployment overlay, empty for the original dedicated-cluster deployment.
    # The sparkey deployment passes ../module-config/values-sparkey.yaml here to
    # disable the chart's own ingress (GitOps owns the HTTPRoutes there) and to
    # target the dedicated prod NodePool.
    [for f in var.extra_values_files : templatefile(f, { s3_bucket = var.s3_bucket_name })]
  )

  helm_chart_mapped_files = [
    # Package specifications
    {
      name     = "package-international-patient-summary-2.0.1.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-international-patient-summary-2.0.1.json")
    },
    {
      name     = "package-international-patient-summary-2.0.0.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-international-patient-summary-2.0.0.json")
    },
    {
      name     = "package-aucore-2.1.0-draft.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-aucore-2.1.0-draft.json")
    },
    {
      name     = "package-au-base-6.1.1-draft.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-au-base-6.1.1-draft.json")
    },
    {
      name     = "package-au-erequesting-1.0.0.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-au-erequesting-1.0.0.json")
    },
    # SMART auth callback script
    {
      name     = "smart-post-authorize.js"
      location = "classes/config_seeding"
      data     = file("../module-config/smart-post-authorize.js")
    },
    # Consent service enforcing the read-only DEFAULT partition (ADR 0001).
    # Referenced by consent_service.script.file on the aucore fhir_endpoint
    # module in simplified-multinode.yaml.
    {
      name     = "consent-default-readonly.js"
      location = "classes/config_seeding"
      data     = file("../module-config/consent-default-readonly.js")
    },
    {
      name     = "package-au-patient-summary-1.0.0.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-au-patient-summary-1.0.0.json")
    },
    {
      name     = "package-au-base-7.0.0-ballot1.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-au-base-7.0.0-ballot1.json")
    },
    {
      name     = "package-aucore-3.0.0-ballot1.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-aucore-3.0.0-ballot1.json")
    },
    {
      name     = "package-hl7-terminology-7.3.0.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-hl7-terminology-7.3.0.json")
    },
    {
      name     = "package-smart-app-launch-2.2.0.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-smart-app-launch-2.2.0.json")
    },
    # Users configuration moved to AWS Secrets Manager - see extra_secrets below
  ]

  # users.json is mounted via the chart's `secrets.usersConfig` block in
  # module-config/values-common.yaml (secretArn set below), with IRSA read access
  # granted in iam-users-secret.tf. The module's `extra_secrets` input is not used:
  # it would surface a second, redundant CSI secret mount of the same secret.

  # Secret ARNs are injected here rather than committed to the values files.
  # The tokenSigningKeystore entry is only meaningful when an overlay declares
  # the matching mount; merging a stray key is harmless when it does not.
  helm_chart_values_set_overrides = merge(
    {
      "replicaCount" = 1
      # Set the secret ARN for users.json
      "secrets.usersConfig.secretArn" = data.aws_secretsmanager_secret.smilecdr_users_json.arn
    },
    var.token_signing_secret_name == null ? {} : {
      "secrets.tokenSigningKeystore.secretArn" = data.aws_secretsmanager_secret.token_signing[0].arn
    }
  )

  s3_read_buckets = [var.s3_bucket_name]

  ################################################################################
  # RDS Configuration
  ################################################################################
  #
  # With the following sections of configuration, the Smile CDR Dependencies
  # Terraform module will create a new RDS instance and configure Smile CDR to
  # connect to it automatically.

  # Comment out this entire section and include database.yml under module-config to enable in cluster crunchypgo

  #################################
  ## RDS Instances Configuration ##
  #
  # This module supports creation multiple RDS instances. The below configuration
  # creates a single Aurora Postgres Serverless V2 database cluster.
  #
  # By default, subnet selection is performed in the following order in descending priority
  #
  # * Use subnets provided by `db_subnet_ids`
  # * Use custom auto-discovery provided by `db_subnet_discovery_tags`
  # * Use auto-discovery using `Tier = Database`
  # * Use auto-discovery using `Tier = Private`
  # * Use auto-discovery using `Tier = Public`
  #
  # If no subnets are configured or  auto-discovered, the module will return an error.

  db_instances = [
    {
      name   = "SmileCluster"
      engine = "aurora-postgresql-serverless-v2"
      # In-place major upgrade to PostgreSQL 16 (Smile CDR 2026.05 recommends 16;
      # PG14 community EOL is 2026-11). The pin must match the live version before
      # the change; Aurora does not support downgrades, so a mismatch produces an
      # invalid destroy/replace. See terraform/REMEDIATION.md and
      # docs/aurora-pg16-upgrade-plan.md. allow_major_version_upgrade and
      # apply_immediately are required for the engine change to run at apply time
      # rather than the maintenance window; both are safe to leave set.
      engine_version              = "16.13"
      allow_major_version_upgrade = true
      apply_immediately           = true
      serverless_configuration = {
        min_capacity = 0.5
        max_capacity = 4
      }

      # Name for this deployment's RDS DB subnet group.
      #
      # Required for a second deployment, not a preference. The module's
      # generated name does NOT carry resourcenames_suffix: it is built as
      # "<name>-<db instance name>", i.e. "smile-smilecluster" for BOTH
      # deployments. The first sparkey apply failed on exactly that:
      #
      #   Error: creating RDS DB Subnet Group (smile-smilecluster):
      #   DBSubnetGroupAlreadyExists
      #
      # Note this input names a group the module CREATES; it is not a reference to
      # an existing one. Pointing it at sparkey's own `sparkey-vpc` group just
      # moves the collision. A per-deployment group is also the established
      # pattern on this cluster: ontoserver and logimomo each have their own
      # (sparkey-ontoserver-master-*, sparkey-logimomo-master-*) over the same
      # three Tier=Database subnets. Several groups over the same subnets is
      # normal in RDS.
      #
      # Null (the default) on the original deployment, which keeps its existing
      # smile-smilecluster group untouched.
      db_subnet_group_name = var.db_subnet_group_name

      ## Use alternate subnet discovery tags like so:
      # db_subnet_discovery_tags = {
      #  TagName = "TagValue"
      # }

      ## Explicitly configure Databse subnets like so:
      # db_subnet_ids = [
      #   "subnet-0abc123",
      #   "subnet-0def456"
      # ]

      # db_subnet_ids = data.aws_db_subnet_group.k8s.subnet_ids

      # TODO: Implement this later on.
      ## Using an externally provisioned RDS instance
      # externally_provisioned = true

    }
  ]

  # #######################################
  # ## RDS Database & User Configuration ##
  # #
  # # This section is used to auto-configure databases, users, credential secrets and
  # # Smile CDR configuration to use the database.
  # #
  # # To follow best practices, each database should use separate connection credentials which
  # # is easily achived by adding multiple entries in the `db_users` list below.
  # #
  # # Each entry should use the following schema:
  # #
  # # `name` - Friendly name used for resource naming. If `cdr_modules` is not provided, this should match the Smile CDR module name that will be using this database user.
  # # `cdr_modules` - List of Smile CDR modules that should use this database user. Defaults to a single entry with the value of `name`.
  # # `dbusername` - The database user name.
  # # `dbname` - The database name.
  # # `db_instance_name` - The database instance that this user must use. Must refer to a database instance defined in `db_instances`.
  # # `auth_type` - The authentication method to configure (`password`, `iam` or `secretsmanager`). Default `password`.

  db_users = [
    {
      name             = "clustermgr"
      dbusername       = "clustermgr"
      dbname           = "clustermgr"
      db_instance_name = "SmileCluster"
      }, {
      name             = "persistence"
      dbusername       = "persistence"
      dbname           = "persistence"
      db_instance_name = "SmileCluster"
      }, {
      name             = "ereq"
      dbusername       = "ereq"
      dbname           = "ereq"
      db_instance_name = "SmileCluster"
      }, {
      name             = "hl7au"
      dbusername       = "hl7au"
      dbname           = "hl7au"
      db_instance_name = "SmileCluster"
      }, {
      name             = "aucore"
      dbusername       = "aucore"
      dbname           = "aucore"
      db_instance_name = "SmileCluster"
      }, {
      name             = "audit"
      dbusername       = "audit"
      dbname           = "audit"
      db_instance_name = "SmileCluster"
      }, {
      name             = "transaction"
      dbusername       = "transaction"
      dbname           = "transaction"
      db_instance_name = "SmileCluster"
    }
  ]

  ################################################################################
  # Ingress Configuration
  ################################################################################

  # Empty when the cluster's own GitOps owns routing and DNS (the sparkey
  # deployment). An empty map is explicitly supported by the module: its
  # validation is `length(var.ingress_config) == 0 || alltrue([...])`, and the
  # Gateway lookup, the aws_lb lookup and the Route53 record are all gated on
  # having an entry.
  #
  # That gating matters here for a second reason. In `gatewayapi` mode the module
  # resolves the Gateway's load balancer with the `aws_lb` data source, which is
  # ELBv2 only. sparkey's Envoy Gateway is fronted by a CLASSIC ELB (its Service
  # carries only aws-load-balancer-proxy-protocol, no
  # aws-load-balancer-type: external, so the in-tree cloud provider serves it), so
  # that lookup would fail outright. Letting external-dns own the record from the
  # HTTPRoute hostname sidesteps it and matches how every other workload on that
  # cluster gets DNS. Revisit if sparkey's gateway is ever moved to an NLB.
  ingress_config = var.manage_ingress ? {
    public = {
      # The live serving ingress is the chart's default slot (rendered as
      # smilecdr-scdr, class nginx, host smile.sparked-fhir.com). Claim the default
      # slot with nginx-ingress so the plan reconciles in place rather than
      # disabling the default ingress and standing up a gateway-api/ALB one.
      useDefaultIngress     = true
      ingressType           = "nginx-ingress"
      route53_create_record = local.route53_create_record
      parent_domain         = var.domain
    }
  } : {}

}

locals {
  route53_create_record = true

  # The IAM role the module builds for this deployment, needed by
  # iam-users-secret.tf to attach one extra policy.
  #
  # Supplying this by hand (var.smilecdr_iam_role_name) cannot work for a
  # deployment that does not exist yet: without var.resourcenames_suffix the
  # module generates the name with a random_id, so it is unknowable before the
  # first apply, making a new deployment a two-pass operation.
  #
  # So: set var.resourcenames_suffix and the name becomes deterministic. The
  # module builds it as "${name}-smilecdr-${resourcenames_suffix}" and passes it
  # with use_name_prefix = false, so this reproduces it exactly.
  #
  # NOT derived from the module's helm_sa_annotation output, which looks like the
  # obvious source but is broken upstream at v9.0.2: it reads
  # `module.smile_cdr_irsa_role[0].iam_role_arn` while pinning
  # terraform-aws-modules/iam v6.2.3, where that output was renamed to `arn`. The
  # surrounding try() swallows the missing attribute, so the output silently
  # returns null rather than failing. (The module's own local.iam_role_arn uses
  # `.arn` and is correct; only the output is wrong.)
  smilecdr_iam_role_name = var.smilecdr_iam_role_name != null ? var.smilecdr_iam_role_name : "${var.name}-smilecdr-${var.resourcenames_suffix}"

  tags = {
    Name       = var.name
    Repository = "github.com/aehrc/sparked-fhir-server-configuration"
  }
}

# AU Patient Summary generator jar, consumed by the aucore node's
# ig_support.ips.generation_strategy_class (au.org.hl7.fhir.ps.strategy.AupsGenerationStrategy).
# Sourced from aehrc/sparked-fhir-operations release v1.0.0. The chart's
# copyFiles.customerlib block in module-config/values-common.yaml pulls this object
# from S3 into the smilecdr customerlib classpath at pod startup. Managing the upload
# here keeps the deployed artifact version codified and reproducible via terraform apply,
# rather than relying on a manual out-of-band upload.
resource "aws_s3_object" "aups_generator" {
  bucket = var.s3_bucket_name
  key    = "smile/hapi-aups-generator-1.0.0.jar"
  source = "../module-config/lib/hapi-aups-generator-1.0.0.jar"
  etag   = filemd5("../module-config/lib/hapi-aups-generator-1.0.0.jar")
  tags   = local.tags
}