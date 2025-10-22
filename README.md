# Sparked FHIR Server Configuration

Infrastructure-as-Code repository for deploying and configuring the Sparked FHIR Server (Smile CDR) on AWS EKS.

## Overview

This repository manages the deployment of a multi-node Smile CDR FHIR server using Terraform and Helm. The server hosts multiple FHIR Implementation Guides (IGs) relevant to Australian healthcare standards and is deployed as part of the Sparked program.

## Current Configuration

### Infrastructure Components

- **Platform**: Smile CDR deployed on AWS EKS via Terraform
- **Database**: Aurora PostgreSQL Serverless V2 (0.5-4 ACU)
- **Deployment Method**: Helm charts with custom configuration overlays
- **DNS/Ingress**: Route53 with public ingress configuration

### Loaded Implementation Guides

The server currently loads the following FHIR packages (defined in [main.tf](main.tf)):

- **AU Core** - Australian Core FHIR profiles
- **AU Base** - Australian Base FHIR profiles
- **AU eRequesting** (v1.0.0) - Electronic requesting
- **AU Patient Summary** (v0.3.0) - Patient summary profiles
- **IPS** (v2.0.0-ballot) - International Patient Summary

### Database Modules

Separate database instances configured for:
- Cluster Manager (`clustermgr`)
- FHIR Persistence (`persistence`)
- AU eRequesting (`ereq`)
- HL7 AU (`hl7au`)
- AU Core (`aucore`)
- Audit logs (`audit`)
- Transactions (`transaction`)

### Key Files

- [main.tf](main.tf) - Primary Terraform configuration and Smile CDR module setup
- [module-config/simplified-multinode.yaml](module-config/simplified-multinode.yaml) - Smile CDR node configuration
- [module-config/values-common.yaml](module-config/values-common.yaml) - Common Helm chart values
- [module-config/packages/](module-config/packages/) - FHIR IG package specifications
- [module-config/users.json.tpl](module-config/users.json.tpl) - User configuration template

## 🚀 Making Requests

**This repository now accepts requests via GitHub Issues!**

### For Non-Technical Users

📖 **[Read the User Guide](docs/USER_GUIDE.md)** - Complete guide for content teams and non-technical users

### Quick Start

1. Go to [Issues](../../issues) → **New Issue**
2. Choose a template:
   - **IG Release Request** - Add/update FHIR Implementation Guides
   - **Configuration Change** - Modify server behavior or settings
   - **Operational Request** - Load/delete data, run maintenance
3. Fill out the form (don't worry if you can't answer everything!)
4. Submit and track progress via status labels

### What You Can Request

| Request Type | Examples | Timeline |
|--------------|----------|----------|
| **IG Release** | Update IPS to v3.0.0, Add new AU specification | 1-2 weeks |
| **Configuration** | Enable subscriptions, Add new endpoint, Change security | 1-3 weeks |
| **Operations** | Load test data, Expunge old data, Refresh environment | Hours to days |

### Request Status Labels

Watch your issue for status updates:
- `needs-review` → Request received, awaiting review
- `status:approved` → Approved and ready to implement
- `status:in-progress` → Team is actively working on this
- `status:testing` → Changes deployed, ready for verification
- `status:complete` → Done! Please verify and close if satisfied

## Planned Improvements

### 1. Additional Automation

**Goal**: Create self-service pipelines for common operations.

- Automated test data loading workflows
- On-demand `$expunge` operations via GitHub Actions
- Automated Terraform plan/apply for approved changes
- Package validation before deployment

### 2. Enhanced Documentation

**Goal**: Comprehensive user-focused documentation.

- Single-page server capabilities overview (Confluence)
- Detailed capability pages for specific features
- SLA documentation and support expectations
- Engagement guide for content teams (see [User Guide](docs/USER_GUIDE.md))

### 3. Governance & ADR Process

**ADR Requirements**:
- All significant technical decisions require ADR approval via decision makers (DTR, Brett Esler)
- Issues requiring ADR will be labeled with `needs:adr`
- ADR approval adds 1-2 weeks to timeline

**SLA Expectations**:
- Best-effort for non-production environments
- This is NOT a reference implementation - it's Sparked program-specific
- Change verification process required for all deployments

### 4. Communication Workflows

**Communication Channels**:
- **GitHub Issues**: Request tracking, technical discussions, status updates
- **Zulip**: Public release announcements, stakeholder notifications
- **Teams**: Internal team coordination
- **Confluence**: User-focused documentation, capabilities reference
- **CSIRO JIRA**: Internal project tracking (Puma projects)

**Notification Flow**:
1. Request submitted → Automated GitHub comment with next steps
2. Status changes → Automated GitHub comments on milestones
3. Deployment complete → Zulip announcement to stakeholders
4. Verification needed → GitHub comment mentioning requestor

### 5. Status & Monitoring

**Planned Features**:
- Status page for outage notifications
- Usage statistics and metrics
- Test environment availability calendar

## Development Workflow

### Current Workflow (Issue-Based)
1. **Request Submission**: User creates GitHub issue using template
2. **Technical Review**: Team reviews, adds implementation notes, applies labels
3. **Approval**: Issue labeled `status:approved` (or `needs:adr` if ADR required)
4. **Implementation**:
   - Update [module-config/simplified-multinode.yaml](module-config/simplified-multinode.yaml) for Smile CDR configuration
   - Add/update package files in [module-config/packages/](module-config/packages/)
   - Modify [main.tf](main.tf) for infrastructure changes
   - Create Pull Request referencing the issue
5. **Code Review**: PR reviewed and merged
6. **Deployment**: Terraform apply to deploy changes
7. **Verification**: Requestor verifies functionality
8. **Completion**: Issue closed, Zulip notification sent

### For Technical Contributors
When implementing requests:
1. Comment on the issue with technical implementation plan
2. Create a branch: `feature/issue-<number>-short-description`
3. Make configuration changes
4. Run validation: `terraform validate` and YAML linting
5. Create PR linking to issue: `Closes #<issue-number>`
6. Deploy after PR approval
7. Comment on issue with verification instructions
8. Close issue after requestor verification

## Important Notes

- This is **not a reference implementation** - it is a Sparked program-specific server
- The server reflects the current state of the Sparked program
- For new features or significant changes, create an ADR for decision-maker approval
- All changes should be verified to ensure they meet stakeholder expectations

## Technical Setup

### Prerequisites
- AWS credentials configured
- Terraform >= 1.0
- kubectl access to target EKS cluster
- Access to Smile CDR registry credentials (AWS Secrets Manager)

### Local Development
```bash
# Initialize Terraform
terraform init

# Review planned changes
terraform plan -var-file=tfvars/dev.tfvars

# Apply configuration
terraform apply -var-file=tfvars/dev.tfvars

# Validate YAML configuration
yamllint module-config/*.yaml

# Validate JSON packages
find module-config/packages -name "*.json" -exec jq empty {} \;
```

### Example: Adding a New IG Package

Let's say you need to add IPS version 3.0.0 (as your supervisor requested). Here's what changes:

#### 1. Create Package File
Create `module-config/packages/package-ips-3.0.0.json`:
```json
{
  "name": "hl7.fhir.uv.ips",
  "version": "3.0.0"
}
```

#### 2. Update main.tf
In the `helm_chart_mapped_files` section, add:
```hcl
{
  name     = "package-ips-3.0.0.json"
  location = "classes/config_seeding"
  data     = file("module-config/packages/package-ips-3.0.0.json")
}
```

#### 3. Update simplified-multinode.yaml (if needed)
Add or update the IPS module configuration if required.

#### 4. Apply Changes
```bash
terraform plan -var-file=tfvars/dev.tfvars
terraform apply -var-file=tfvars/dev.tfvars
```

## Support & Contact

- **Submit Requests**: [GitHub Issues](../../issues)
- **User Guide**: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- **Announcements**: Sparked Zulip channels
- **Internal Support**: Teams chat or CSIRO JIRA (Puma project)

## Repository Structure

```
sparked-fhir-server-configuration/
├── .github/
│   ├── ISSUE_TEMPLATE/          # Request templates for users
│   │   ├── 01-ig-release-request.yml
│   │   ├── 02-configuration-change.yml
│   │   └── 03-operational-request.yml
│   └── workflows/               # GitHub Actions automation
│       ├── validate-config.yml  # Validates configuration changes
│       └── issue-management.yml # Auto-labels and tracks issues
├── docs/
│   └── USER_GUIDE.md           # Non-technical user guide
├── module-config/
│   ├── simplified-multinode.yaml  # Smile CDR configuration
│   ├── values-common.yaml         # Helm chart values
│   ├── users.json.tpl            # User configuration template
│   └── packages/                 # FHIR IG package specifications
│       ├── package-aubase.json
│       ├── package-aucore.json
│       ├── package-auereq-1.0.0.json
│       ├── package-aups-0.3.0.json
│       └── package-ips-2.0.0-ballot.json
├── tfvars/                       # Terraform variable files (per environment)
├── main.tf                       # Main Terraform configuration
├── variables.tf                  # Variable definitions
├── provider.tf                   # Provider configuration
└── data.tf                       # Data sources

---

**Status**: ✅ Request system active! Submit requests via [GitHub Issues](../../issues)
