# Sparked FHIR Server Configuration

> Infrastructure-as-Code for deploying and managing the Sparked FHIR Server (Smile CDR) on AWS EKS

## Overview

This repository manages the deployment and configuration of a multi-node Smile CDR FHIR server for the Sparked program. The server hosts multiple FHIR Implementation Guides (IGs) relevant to Australian healthcare standards.

### Key Features

- **Automated IG Deployment** - Request and deploy FHIR IGs through GitHub Issues
- **Multi-Node Configuration** - Deploy to specific SmileCDR nodes (aucore, ereq)
- **Automatic Validation** - Instant feedback on configuration changes
- **Flexible Deployment** - Deploy immediately, schedule for later, or wait for restart
- **Complete Audit Trail** - All changes tracked in git with issue references

## Contents

- [Service Catalogue](#service-catalogue) - request any change
- [Quick Start](#quick-start) - load or clear test data
- [Documentation](#documentation)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [How It Works](#how-it-works)
- [For Developers](#for-developers)
- [For Repo Admins](#for-repo-admins)
- [Important Notes](#important-notes)
- [CI/CD Setup](#cicd-setup)
- [Troubleshooting](#troubleshooting)
- [Support](#support)

## Service Catalogue

Every change to the Sparked FHIR Server is requested as a structured issue. Pick the
offering that matches your need and click **Raise request**. Blank issues are disabled, so
anything that does not fit a specific offering (a bug, a question, an idea, or a rollback)
goes through **General / Bug / Question**.

| Offering | What it's for | Automation | Target SLA | Raise request |
|----------|---------------|------------|------------|---------------|
| **IG Release** | Add, update, or roll back a FHIR Implementation Guide | Semi-automated | 1 to 2 weeks | [Raise request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=01-ig-release-request.yml) |
| **Configuration Change** | Change Smile CDR modules, endpoints, security, or settings | Manual | 1 to 3 weeks | [Raise request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=02-configuration-change.yml) |
| **Operational Request** | Load test data, expunge, refresh, restart, backup/restore | Semi-automated | Hours to days | [Raise request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=03-operational-request.yml) |
| **Terminology Content Change** | Add/remove/modify IG packages on tx.dev / tx.hl7 | Semi-automated | 1 to 2 weeks | [Raise request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=04-tx-content-change.yml) |
| **SMART App / OIDC Registration** | Register a SMART on FHIR or backend OIDC client | Semi-automated | 1 to 3 business days | [Raise request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=05-smart-app-registration.yml) |
| **General / Bug / Question** | Anything not covered above, including rollback | Manual (triage) | Best-effort | [Raise request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=06-general-request.yml) |

For per-offering detail, the request lifecycle, the label legend, and what happens after you
submit, see **[docs/SERVICE-CATALOGUE.md](docs/SERVICE-CATALOGUE.md)**.

## Quick Start

### Load or clear test data

This is the one common task that does not need an issue. For everything else, pick an
offering in the [Service Catalogue](#service-catalogue) above.

**Via GitHub Actions (recommended):**
1. Go to **Actions** -> **Manage Test Data** -> **Run workflow**
2. Select operation: `clear-and-load-aucore`, `clear-and-load-ereq`, `clear-and-load-aucore-and-ereq`, or `clear-and-expunge`
3. Optionally enable dry run to preview changes first

**Via issue request:** raise an [Operational Request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=03-operational-request.yml), then an admin approves it (`approved` label) and the data loads automatically.

Test data management is powered by the [`sparked-test-data-loader`](https://github.com/aehrc/sparked-test-data-loader) Go tool.

## Documentation

| Document | Purpose | Audience |
|----------|---------|----------|
| **[Service Catalogue](docs/SERVICE-CATALOGUE.md)** | Menu of every request type, its SLA, and what happens after you submit | Everyone |
| **[Workflow Guide](docs/WORKFLOWS.md)** | Complete guide to all automated workflows | Everyone |
| **[SMART App Registration](docs/SMART-APP-REGISTRATION.md)** | Register SMART on FHIR / OIDC clients | Developers/Participants |
| **[Scripts README](scripts/README.md)** | How to use Python scripts locally | Developers/Admins |
| **[Terraform Local Deploy](docs/terraform-local-deploy.md)** | Plan/apply the infrastructure from a workstation (terraform is local-only) | Admins |

## Architecture

### Infrastructure Components

- **Platform**: Smile CDR on AWS EKS (managed via Terraform)
- **Database**: Aurora PostgreSQL Serverless V2 (0.5-4 ACU)
- **Deployment**: Helm charts with custom configuration overlays
- **DNS/Ingress**: Route53 with public ingress configuration

### SmileCDR Nodes

The FHIR nodes below make up the **Sparked Dev FHIR Server**, CSIRO-hosted on
`smile.sparked-fhir.com` and sharing the CSIRO credentials used by the automation. This is
not the HL7 AU reference server at `fhir.hl7.org.au`, which is a separate system (see
[Governance](#governance)).

| Node | Purpose | FHIR endpoint | Database Module |
|------|---------|---------------|----------------|
| `aucore` | AU Core node of the Sparked Dev FHIR Server | `smile.sparked-fhir.com/aucore/fhir/DEFAULT` | aucore |
| `ereq` | eRequesting node of the Sparked Dev FHIR Server | `smile.sparked-fhir.com/ereq/fhir/DEFAULT` | ereq |
| - | Cluster management | - | clustermgr |
| - | FHIR persistence layer | - | persistence |
| - | Audit logs | - | audit |
| - | Transactions | - | transaction |

### Current Implementation Guides

The server currently hosts (see [module-config/packages/](module-config/packages/) for complete list):

- **AU Core** - Australian Core FHIR profiles
- **AU Base** - Australian Base FHIR profiles
- **AU eRequesting** - Electronic requesting specifications
- **AU Patient Summary** - Patient summary profiles
- **IPS** - International Patient Summary

## Repository Structure

```
sparked-fhir-server-configuration/
├── .github/
│   ├── ISSUE_TEMPLATE/          # Service catalogue request forms
│   │   ├── config.yml                     # Chooser config (blank issues disabled)
│   │   ├── 01-ig-release-request.yml
│   │   ├── 02-configuration-change.yml
│   │   ├── 03-operational-request.yml
│   │   ├── 04-tx-content-change.yml
│   │   ├── 05-smart-app-registration.yml
│   │   └── 06-general-request.yml
│   ├── labels.yml               # Label source of truth (synced by sync-labels.yml)
│   └── workflows/               # GitHub Actions automation
│       ├── issue-opened.yml            # Validates requests on creation
│       ├── issue-labeled.yml           # Creates PRs automatically
│       ├── pr-merged.yml               # Handles post-merge deployment
│       ├── reload-ig-config.yml        # Deploys packages to nodes
│       ├── load-test-data.yml          # Load FHIR test data to a node
│       ├── clear-test-data.yml         # Clear FHIR test data from a node
│       ├── manage-test-data.yml        # Common test data operations (clear+load, expunge)
│       ├── register-smart-clients.yml  # Register SMART/OIDC clients
│       ├── validate-config.yml         # Validates config on PR
│       ├── sync-labels.yml             # Syncs labels.yml (non-destructive)
│       ├── add-to-project.yml          # Adds new issues to the catalogue board
│       └── smile-application.yml       # Terraform plan/apply
├── docs/
│   ├── SERVICE-CATALOGUE.md          # Catalogue of request types, SLAs, lifecycle
│   ├── WORKFLOWS.md                  # Complete workflow guide
│   ├── SMART-APP-REGISTRATION.md     # SMART/OIDC client registration guide
│   └── confluence-connectathon-entry.md  # Content for Confluence connectathon pages
├── scripts/                 # Python/shell automation (package sync, SMART clients, labels); see scripts/README.md
├── module-config/           # SmileCDR node config, Helm values, and packages/ (one JSON per IG version)
├── terraform/               # Terraform for the EKS/Aurora infrastructure
└── terminology-servers/     # Helm values for the tx.dev and tx.hl7 terminology servers
```

> The `.github/` tree is listed in full because it drives the request automation. The other
> directories are summarised to avoid drift; browse them directly for the current file list.

## Key Files Explained

### Configuration Files

- **[module-config/simplified-multinode.yaml](module-config/simplified-multinode.yaml)** - Defines SmileCDR node behavior, endpoints, and which packages each node loads
- **[module-config/packages/](module-config/packages/)** - JSON files specifying FHIR packages (name, version, install mode, dependencies)
- **[terraform/main.tf](terraform/main.tf)** - Terraform configuration linking packages to Helm deployment
- **[module-config/users.json.tpl](module-config/users.json.tpl)** - User accounts and permissions template

### Automation Scripts & Tools

- **[sparked-test-data-loader](https://github.com/aehrc/sparked-test-data-loader)** - Go tool for loading and clearing FHIR test data (used by workflows)
- **[scripts/sync_packages.py](scripts/sync_packages.py)** - Core package synchronization logic (install/update/remove packages on SmileCDR nodes)
- **[scripts/update_node_packages.py](scripts/update_node_packages.py)** - Safely updates simplified-multinode.yaml preserving formatting and comments

## How It Works

At a glance, an IG release flows from issue to deployment like this:

```
Issue created → Automatic validation → Admin approves (ready-for-automation)
→ PR auto-created → Admin reviews & merges → Deployment (auto or manual) → User verifies & closes
```

Validation and PR creation are automated; request approval, PR review, and deployment
verification are the human gates. For the full lifecycle, per-offering behaviour, and the
label legend, see **[docs/SERVICE-CATALOGUE.md](docs/SERVICE-CATALOGUE.md)** and
**[docs/WORKFLOWS.md](docs/WORKFLOWS.md)**.

## For Developers

### Local Development

```bash
# Clone repository
git clone https://github.com/aehrc/sparked-fhir-server-configuration.git
cd sparked-fhir-server-configuration

# Install Python dependencies
pip install -r scripts/requirements.txt

# Set credentials (for testing deployment scripts)
export SMILECDR_BASE_URL="https://smile.sparked-fhir.com"
export SMILECDR_AUTH_BASIC="your_base64_credentials"

# Test package sync (dry-run)
python scripts/sync_packages.py \
  --nodes aucore \
  --source config \
  --dry-run

# Test config update (dry-run)
python scripts/update_node_packages.py \
  --action add \
  --nodes aucore,ereq \
  --package package-example.json \
  --dry-run

# Set up Terraform (see docs/terraform-local-deploy.md for the full deploy runbook)
cd terraform
cp terraform.tfvars.example terraform.tfvars   # Edit with your values
cp backend.hcl.example backend.hcl             # Edit with your S3 bucket
terraform init -backend-config=backend.hcl

# Review planned changes
terraform plan

# Validate configuration
terraform validate
cd ..
yamllint module-config/*.yaml
find module-config/packages -name "*.json" -exec jq empty {} \;
```

> Terraform is applied **locally, not in CI**. For the full deploy procedure
> (prerequisites, safety snapshot, plan review, apply, verification, rollback) see
> [`docs/terraform-local-deploy.md`](docs/terraform-local-deploy.md). For recovering from
> module/provider drift, see [`terraform/REMEDIATION.md`](terraform/REMEDIATION.md).

### Reproducing this setup in your own AWS account

This repository is intended to be a reusable pattern for running SmileCDR on
AWS (EKS + Aurora) with issue-driven configuration automation. Everything that
ties it to the Sparked program's infrastructure is externalized, so you can
stand up your own instance:

- All AWS-specific values are variables: `s3_bucket_name`, `cdr_regcred_secret_arn`,
  `smilecdr_iam_role_name` (see `terraform/terraform.tfvars.example`), the state
  backend bucket (`terraform/backend.hcl.example`), and `AWS_ACCOUNT_ID` /
  `AWS_OIDC_ROLE_ARN` as GitHub repository variables. None are committed.
- Fork the repo, supply your own values, point the Terraform backend at your own
  state bucket, and `terraform apply` from your workstation against your own account.
- Credentials live in AWS Secrets Manager and GitHub Actions secrets in your own
  org, not in this repository.

You cannot deploy to the Sparked-hosted infrastructure from a fork: the OIDC role
trust policy is scoped to the upstream repository, the state bucket is private, and
no credentials are published here. Treat the concrete hostnames, ARNs, and account
references in the docs as examples to replace with your own.

### Testing Workflows Locally

```bash
# Install GitHub CLI
brew install gh
gh auth login

# Test validation workflow (validate-ig job)
gh workflow run issue-opened.yml -f issue_number=123 -f job_type=validate-ig

# Test PR creation workflow (create-ig-pr job)
gh workflow run issue-labeled.yml -f issue_number=123 -f job_type=create-ig-pr

# View workflow logs
gh run list --workflow=issue-opened.yml
gh run view <run-id> --log
```

## For Repo Admins

### Daily Operations

1. **Monitor new issues** - Review and validate requests
2. **Approve automation** - Add `ready-for-automation` label when ready
3. **Review auto-PRs** - Check configuration before merging
4. **Choose deployment** - Immediate, scheduled, or on-restart
5. **Monitor verification** - Ensure requesters verify deployments
6. **Close issues** - When verified and complete

### Common Admin Tasks

**Manually deploy packages:**
```bash
# Via GitHub Actions
Actions → "Re/load IG Packages" → Run workflow

# Via script locally
python scripts/sync_packages.py \
  --nodes aucore,ereq \
  --source config \
  --dry-run  # Remove for actual deployment
```

**Update simplified-multinode.yaml manually:**
```bash
# Add package to nodes
python scripts/update_node_packages.py \
  --action add \
  --nodes aucore,ereq \
  --package package-international-patient-summary-2.0.1.json

# Remove package from nodes
python scripts/update_node_packages.py \
  --action remove \
  --nodes aucore \
  --package package-old-version.json
```

**Rollback a deployment:**
1. Create new issue with Request Type: "Rollback"
2. Specify previous version
3. Follow normal workflow
4. Old version replaces new version

## Important Notes

### This is NOT a Reference Implementation

- This server is specific to the Sparked program
- Configuration reflects Sparked program requirements
- For reference implementations, see HL7 or official FHIR resources

### Governance

- **ADR Required** for significant technical decisions (new modules, major config changes)
- **Decision Makers**: DTR, Brett Esler
- **ADR Timeline**: Add 1-2 weeks to implementation timeline

#### HL7-hosted reference environments (elevated approval)

Two environments are HL7-hosted reference systems, separate from the CSIRO-hosted Sparked
dev nodes on `smile.sparked-fhir.com`, and require higher scrutiny:

| Environment | What it is | Managed here? |
|-------------|------------|---------------|
| `fhir.hl7.org.au` | The official HL7 AU FHIR reference server | Not an automation target; changes are out of band |
| `tx.hl7` (`synd.tx.hl7.org.au`) | The HL7 AU terminology reference server | Yes, via the Terminology Content offering (`tx-hl7-helm-values.yaml`) |

Any request that changes one of these environments must be labelled **`needs:hl7-approval`**
and receive **Brett Esler's** sign-off before it is `approved` or `ready-for-automation`.
This is a documented process gate: reviewers must not approve or arm automation on such a
request until that sign-off is recorded on the issue. The CSIRO Sparked dev nodes (`aucore`,
`ereq`) follow the normal workflow.

### SLA Expectations

- Best-effort for non-production environments
- Production changes require testing in dev/staging first
- All deployments must be verified by requestor

## CI/CD Setup

The following GitHub configuration is required for CI/CD workflows:

### Repository Variables (Settings > Secrets and variables > Actions > Variables)

| Variable | Description |
|----------|-------------|
| `AWS_OIDC_ROLE_ARN` | ARN of the IAM role for GitHub Actions AWS OIDC federation. Its trust policy must be scoped to this repository (and a specific ref/environment) so no fork or pull request can assume it. |
| `AWS_ACCOUNT_ID` | AWS account ID, used to build the test-data loader ECR image reference. Parameterized so the account ID is not hardcoded in the public repo. |
| `CATALOGUE_PROJECT_URL` | (optional) URL of the service-catalogue GitHub Project; set to enable auto-adding new issues to the board |

> **Terraform is applied locally, not in CI.** The `Smile Configuration Deployment`
> workflow (`smile-application.yml`) is intentionally disabled: running
> `terraform plan`/`apply` against live infrastructure in a public repo would publish
> plan output (secret ARNs, resource IDs, topology) to PR comments, job summaries,
> artifacts, and run logs. Apply from a workstation with the gitignored
> `terraform/backend.hcl` and `terraform/terraform.tfvars`, following the deploy runbook
> [`docs/terraform-local-deploy.md`](docs/terraform-local-deploy.md).

### Repository Secrets (Settings > Secrets and variables > Actions > Secrets)

| Secret | Description |
|--------|-------------|
| `CSIRO_FHIR_AUTH_64` | Base64-encoded SmileCDR API credentials |
| `FHIRFLARE_API_KEY` | FHIRFlare integration API key |
| `FHIRFLARE_URL` | FHIRFlare service URL |
| `FHIR_USERNAME` | FHIR server username |
| `FHIR_PASSWORD` | FHIR server password |
| `ADD_TO_PROJECT_PAT` | (optional) PAT with Projects read/write, used with `CATALOGUE_PROJECT_URL` to add issues to the board |

## Communication Channels

| Channel | Used For |
|---------|----------|
| **GitHub Issues** | Request tracking, technical discussions, status updates |
| **GitHub PRs** | Code review, configuration changes |
| **Zulip** | Public release announcements, stakeholder notifications |

## Troubleshooting

### Common Issues

**Q: Validation fails with "No nodes selected"**
- A: Edit the issue and check at least one node checkbox

**Q: PR not created after adding ready-for-automation label**
- A: Check validation passed first (look for ✅ in validation comment)

**Q: Package deployment fails**
- A: Check SmileCDR logs, verify package exists in registry, try force_reinstall=true

**Q: Test data load excludes files I need**
- A: Ensure files are not in `vendor-demonstrator` folder

👉 **[See Complete Troubleshooting Guide](docs/WORKFLOWS.md#troubleshooting)**

## Support

- **Questions, bugs, feature requests:** raise a [General / Bug / Question](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=06-general-request.yml) and pick the matching category (blank issues are disabled)
- **Any other change:** use the [Service Catalogue](#service-catalogue)
- **Questions in chat:** ask in team Zulip
- **Workflow Help:** Check [WORKFLOWS.md](docs/WORKFLOWS.md)
- **Script Help:** Check [scripts/README.md](scripts/README.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the Apache License 2.0 - see [LICENSE](LICENSE) for details.
