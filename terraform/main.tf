module "smile_cdr_dependencies" {
  source                 = "git::https://gitlab.com/smilecdr-public/smile-dh-helm-charts//src/main/terraform/sdh-deps?ref=v9.0.2"
  name                   = var.name
  eks_cluster_name       = var.cluster_name
  cdr_regcred_secret_arn = var.cdr_regcred_secret_arn
  prod_mode              = false
  helm_chart_version     = "7.1.0"


  helm_chart_values = [                                                                        #alpha order
    templatefile("../module-config/values-common.yaml", { s3_bucket = var.s3_bucket_name }), #core - required
    file("../module-config/simplified-multinode.yaml")
  ]

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
    {
      name     = "package-au-patient-summary-1.0.0.json"
      location = "classes/config_seeding"
      data     = file("../module-config/packages/package-au-patient-summary-1.0.0.json")
    },
    # Users configuration moved to AWS Secrets Manager - see extra_secrets below
  ]

  # users.json is mounted via the chart's `secrets.usersConfig` block in
  # module-config/values-common.yaml (secretArn set below), with IRSA read access
  # granted in iam-users-secret.tf. The module's `extra_secrets` input is not used:
  # it would surface a second, redundant CSI secret mount of the same secret.

  helm_chart_values_set_overrides = {
    "replicaCount" = 1
    # Set the secret ARN for users.json
    "secrets.usersConfig.secretArn" = data.aws_secretsmanager_secret.smilecdr_users_json.arn
  }

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
      # Pin to the live cluster's engine version. AWS auto-upgraded the DB to 14.20;
      # Aurora does not support downgrades, so leaving this unset (module default 14.15)
      # would produce an invalid destroy/replace. See terraform/REMEDIATION.md.
      engine_version = "14.20"
      serverless_configuration = {
        min_capacity = 0.5
        max_capacity = 4
      }

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

  ingress_config = {
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
  }

}

locals {
  route53_create_record = true

  tags = {
    Name       = var.name
    Repository = "github.com/aehrc/sparked-fhir-server-configuration"
  }
}