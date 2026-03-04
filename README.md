# Sparked FHIR Server Configuration

> Infrastructure-as-Code for deploying and managing the Sparked FHIR Server (Smile CDR) on AWS EKS

## Overview

This repository manages the deployment and configuration of a multi-node Smile CDR FHIR server for the Sparked program. The server hosts multiple FHIR Implementation Guides (IGs) relevant to Australian healthcare standards.

### Key Features

- **Automated IG Deployment** - Request and deploy FHIR IGs through GitHub Issues
- **Multi-Node Configuration** - Deploy to specific SmileCDR nodes (aucore, hl7au, ereq)
- **Automatic Validation** - Instant feedback on configuration changes
- **Flexible Deployment** - Deploy immediately, schedule for later, or wait for restart
- **Complete Audit Trail** - All changes tracked in git with issue references

## 🚀 Quick Start

### I want to deploy a FHIR Implementation Guide

1. [Create an IG Release Request](../../issues/new/choose)
2. Fill out the form and select target nodes
3. Review the automatic validation and dry-run preview
4. Wait for admin approval (`ready-for-automation` label)
5. PR is auto-created → reviewed → merged
6. Choose deployment option or let it deploy automatically
7. Verify and close the issue

**Time:** ~20 minutes (mostly automated)

👉 **[Read the Complete Workflow Guide](docs/WORKFLOWS.md)**

### I want to load/clear test data

**Via GitHub Actions (recommended):**
1. Go to **Actions** -> **Manage Test Data** -> **Run workflow**
2. Select operation: `clear-and-load-aucore`, `clear-and-load-ereq`, `clear-and-load-aucore-and-ereq`, or `clear-and-expunge`
3. Optionally enable dry run to preview changes first

**Via issue request:**
1. [Create an Operational Request](../../issues/new/choose)
2. Specify the data source and upload mode
3. Admin approves (`status:approved` label)
4. Data loads automatically
5. Verify and close

**Time:** ~10-30 minutes (depending on data volume)

Test data management is powered by the [`sparked-test-data-loader`](https://github.com/aehrc/sparked-test-data-loader) Go tool.

### I want to register a SMART App / OIDC client

1. [Create a SMART App Registration Request](../../issues/new/choose)
2. Select client type (SMART App Launch or Backend Service)
3. Provide Client ID, name, scopes, and redirect URIs
4. Admin reviews and approves (`ready-for-automation` label)
5. Client is automatically registered
6. Receive your client details and endpoint URLs

**Time:** ~5 minutes (automated after approval)

See **[SMART App Registration Guide](docs/SMART-APP-REGISTRATION.md)**

### I want to change server configuration

1. [Create a Configuration Change Request](../../issues/new/choose)
2. Describe the desired behavior
3. Admin reviews and implements manually
4. Deployment and verification
5. Close when complete

**Time:** 1-3 weeks (varies by complexity)

## 📚 Documentation

| Document | Purpose | Audience |
|----------|---------|----------|
| **[Workflow Guide](docs/WORKFLOWS.md)** | Complete guide to all automated workflows | Everyone |
| **[SMART App Registration](docs/SMART-APP-REGISTRATION.md)** | Register SMART on FHIR / OIDC clients | Developers/Participants |
| **[Scripts README](scripts/README.md)** | How to use Python scripts locally | Developers/Admins |

## Architecture

### Infrastructure Components

- **Platform**: Smile CDR on AWS EKS (managed via Terraform)
- **Database**: Aurora PostgreSQL Serverless V2 (0.5-4 ACU)
- **Deployment**: Helm charts with custom configuration overlays
- **DNS/Ingress**: Route53 with public ingress configuration

### SmileCDR Nodes

| Node | Purpose | Database Module |
|------|---------|----------------|
| `aucore` | AU Core FHIR profiles and validation | aucore |
| `hl7au` | HL7 AU Base specifications and extensions | hl7au |
| `ereq` | eRequesting workflows and integrations | ereq |
| - | Cluster management | clustermgr |
| - | FHIR persistence layer | persistence |
| - | Audit logs | audit |
| - | Transactions | transaction |

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
│   ├── ISSUE_TEMPLATE/          # Request templates
│   │   ├── 01-ig-release-request.yml
│   │   ├── 02-configuration-change.yml
│   │   ├── 03-operational-request.yml
│   │   └── 05-smart-app-registration.yml
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
│       └── smile-application.yml       # Terraform plan/apply
├── docs/
│   ├── WORKFLOWS.md                  # Complete workflow guide
│   ├── SMART-APP-REGISTRATION.md     # SMART/OIDC client registration guide
│   └── confluence-connectathon-entry.md  # Content for Confluence connectathon pages
├── scripts/
│   ├── register_smart_client.py  # Register SMART/OIDC clients
│   ├── manage_smart_users.py     # Create user accounts for SMART auth
│   ├── sync_packages.py          # Sync packages across nodes
│   ├── update_node_packages.py   # Update simplified-multinode.yaml
│   ├── update_tx_helm_values.py  # Update terminology server config
│   ├── generate-ig-pr.sh         # Helper for manual IG PR generation
│   ├── setup-labels.sh           # Set up GitHub issue labels
│   ├── requirements.txt          # Python dependencies
│   └── README.md                 # Script usage guide
├── module-config/
│   ├── simplified-multinode.yaml      # SmileCDR node configuration
│   ├── connectathon-clients.json      # Pre-configured SMART clients for connectathons
│   ├── connectathon-users.json        # Pre-configured user accounts for connectathons
│   ├── values-common.yaml             # Helm chart values
│   ├── users.json.tpl                 # User configuration template
│   └── packages/                      # FHIR IG package specifications
│       ├── package-aubase.json
│       ├── package-aucore.json
│       └── [other packages]
├── terraform/
│   ├── main.tf                  # Main Terraform configuration
│   ├── variables.tf             # Variable definitions
│   ├── provider.tf              # Provider configuration
│   └── data.tf                  # Data sources
└── terminology-servers/
    ├── tx-dev-helm-values.yaml  # TX dev server config
    └── tx-hl7-helm-values.yaml  # TX hl7 server config
```

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

### Automated IG Release Flow

```
┌─────────────────┐
│ User Creates    │
│ Issue           │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Automatic       │
│ Validation      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Admin Approves  │
│ (ready-for-     │
│  automation)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ PR Auto-Created │
│ with Config     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Admin Reviews & │
│ Merges PR       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Deployment      │
│ (Auto or Manual)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ User Verifies & │
│ Closes Issue    │
└─────────────────┘
```

### What Happens Automatically

1. **Issue Created** → Validation runs, dry-run preview posted
2. **Issue Approved** (`ready-for-automation` label) → PR created with config changes
3. **PR Merged** → Deployment options posted (or auto-deploys if requested)
4. **Deployment Complete** → Results posted to issue, user asked to verify

### What Needs Human Review

- **Initial request review** - Admin verifies business justification
- **PR review** - Admin checks auto-generated configuration
- **Deployment verification** - User confirms functionality
- **Issue closure** - Admin closes after verification

## Making Requests

### Types of Requests

| Type | Use When | Example | Timeline |
|------|----------|---------|----------|
| **IG Release** | Adding/updating FHIR specifications | "Deploy IPS 3.0.0 to aucore and hl7au" | 1-2 weeks |
| **Configuration** | Changing server behavior | "Enable FHIR subscriptions on ereq node" | 1-3 weeks |
| **Operations** | Loading/managing data | "Load 50 test patients for testing" | Hours to days |

### Request Status Labels

Watch your issue for status updates:

- `needs-review` → Awaiting admin review
- `status:approved` → Approved, ready for automation
- `status:in-progress` → PR created, being reviewed
- `status:deploying` → Deployment in progress
- `status:deployed` → Deployed, please verify
- `status:complete` → Verified and closed

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
  --nodes aucore,hl7au \
  --package package-example.json \
  --dry-run

# Set up Terraform
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

### Testing Workflows Locally

```bash
# Install GitHub CLI
brew install gh
gh auth login

# Test validation workflow
gh workflow run ig-request-validation.yml -f issue_number=123

# Test PR creation workflow
gh workflow run issue-ig-pr-creator.yml -f issue_number=123

# View workflow logs
gh run list --workflow=ig-request-validation.yml
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
Actions → "Reload IG Packages for SmileCDR Nodes" → Run workflow

# Via script locally
python scripts/sync_packages.py \
  --nodes aucore,hl7au \
  --source config \
  --dry-run  # Remove for actual deployment
```

**Update simplified-multinode.yaml manually:**
```bash
# Add package to nodes
python scripts/update_node_packages.py \
  --action add \
  --nodes aucore,hl7au \
  --package package-ips-2.0.0.json

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

### SLA Expectations

- Best-effort for non-production environments
- Production changes require testing in dev/staging first
- All deployments must be verified by requestor

## CI/CD Setup

The following GitHub configuration is required for CI/CD workflows:

### Repository Variables (Settings > Secrets and variables > Actions > Variables)

| Variable | Description |
|----------|-------------|
| `AWS_OIDC_ROLE_ARN` | ARN of the IAM role for GitHub Actions AWS OIDC federation |

### Repository Secrets (Settings > Secrets and variables > Actions > Secrets)

| Secret | Description |
|--------|-------------|
| `CSIRO_FHIR_AUTH_64` | Base64-encoded SmileCDR API credentials |
| `FHIRFLARE_API_KEY` | FHIRFlare integration API key |
| `FHIRFLARE_URL` | FHIRFlare service URL |
| `FHIR_USERNAME` | FHIR server username |
| `FHIR_PASSWORD` | FHIR server password |

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

- **Questions:** Ask in team Zulip
- **Bugs:** [Create an issue](../../issues/new) with label `bug`
- **Feature Requests:** [Create an issue](../../issues/new) with label `enhancement`
- **Workflow Help:** Check [WORKFLOWS.md](docs/WORKFLOWS.md)
- **Script Help:** Check [scripts/README.md](scripts/README.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the Apache License 2.0 - see [LICENSE](LICENSE) for details.
