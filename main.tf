locals {
  # eks_cluster_name = "fhir-dev-smilecdr"
  cdr_regcred_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:471112546300:secret:example-key-value-x7qP8R"
  route53_create_record = true


  users_json = templatefile("${path.module}/module-config/users.json.tpl", { #switch to external secrets later
    admin_password = jsondecode(data.aws_secretsmanager_secret_version.smilecdr-user-passwords.secret_string)["smilecdr-admin-password"]
    devtester_password = jsondecode(data.aws_secretsmanager_secret_version.smilecdr-user-passwords.secret_string)["smilecdr-devtester-password"]
  })


  tags = {
    Name       = var.name
    Repository = "github.com/aehrc/sparked-infrastructure"
  }

}

module "smile_cdr_dependencies" {
  source           = "git::https://gitlab.com/smilecdr-public/smile-dh-helm-charts//src/main/terraform/smile-cdr-deps?ref=terraform-module"
  name             = var.name
  eks_cluster_name = var.cluster_name
  cdr_regcred_secret_arn = local.cdr_regcred_secret_arn
  prod_mode = false
  helm_chart_version = "4.0.0"


  helm_chart_values = [                       #alpha order
    file("module-config/values-common.yaml"), #core - required
    file("module-config/simplified-multinode.yaml")
  ]

  helm_chart_mapped_files = [
    # Package specifications
    {
      name     = "package-ips-2.0.0-ballot.json"
      location = "classes/config_seeding"
      data     = file("module-config/packages/package-ips-2.0.0-ballot.json")
    },
    {
      name     = "package-aubase.json"
      location = "classes/config_seeding"
      data     = file("module-config/packages/package-aubase.json")
    },
    {
      name     = "package-aucore.json"
      location = "classes/config_seeding"
      data     = file("module-config/packages/package-aucore.json")
    },
    {
      name     = "package-aups-0.3.0.json"
      location = "classes/config_seeding"
      data     = file("module-config/packages/package-aups-0.3.0.json")
    },
    {
      name     = "package-auereq-1.0.0.json"
      location = "classes/config_seeding"
      data     = file("module-config/packages/package-auereq-1.0.0.json")
    },
    {
      name     = "package-au-erequestion-1.0.0-ballot.json"
      location = "classes/config_seeding"
      data     = file("module-config/packages/package-au-erequestion-1.0.0-ballot.json")
    },
    
    # Users configuration
    {
      name     = "users.json"
      location = "classes/config_seeding"
      data     = local.users_json  # Use the templated version
    }
  ]

  helm_chart_values_set_overrides = {
    "replicaCount"                                          = 1
  }

  s3_read_buckets = ["examplebucket-fhir-aws"]

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
      name                = "clustermgr"
      dbusername          = "clustermgr"
      dbname              = "clustermgr"
      db_instance_name    = "SmileCluster"
    }, {
      name                = "persistence"
      dbusername          = "persistence"
      dbname              = "persistence"
      db_instance_name    = "SmileCluster"
    }, {
      name                = "ereq"
      dbusername          = "ereq"
      dbname              = "ereq"
      db_instance_name    = "SmileCluster"
    }, {
      name                = "hl7au"
      dbusername          = "hl7au"
      dbname              = "hl7au"
      db_instance_name    = "SmileCluster"
    }, {
      name                = "aucore"
      dbusername          = "aucore"
      dbname              = "aucore"
      db_instance_name    = "SmileCluster"
    }, {
      name                = "audit"
      dbusername          = "audit"
      dbname              = "audit"
      db_instance_name    = "SmileCluster"
    }, {
      name                = "transaction"
      dbusername          = "transaction"
      dbname              = "transaction"
      db_instance_name    = "SmileCluster"
    }
  ]

  ################################################################################
  # Ingress Configuration
  ################################################################################

  ingress_config = {
    public = {
      route53_create_record = local.route53_create_record
      parent_domain = var.domain
    }
  }

}