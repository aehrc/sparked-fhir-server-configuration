# Workflow Guide

**Complete guide to automated workflows for the Sparked FHIR Server Configuration**

## Overview

This repository uses GitHub Actions workflows to automate FHIR Implementation Guide deployments, configuration changes, and operational tasks.

## Table of Contents

- [IG Release Workflow](#ig-release-workflow)
- [Test Data Management](#test-data-management)
- [SMART Client Registration](#smart-client-registration)
- [Manual Package Deployment](#manual-package-deployment)
- [For Requestors](#for-requestors)
- [For Repo Admins](#for-repo-admins)

---

## IG Release Workflow

### Quick Start (Requestors)

**Goal:** Deploy a FHIR Implementation Guide to SmileCDR nodes

**Time:** ~20 minutes (automated)

#### Step 1: Create Issue

1. Go to [Issues → New Issue](../../issues/new/choose)
2. Select **"Implementation Guide Release Request"**
3. Fill out the form:
   - **IG Name**: e.g., "International Patient Summary"
   - **IG Version**: e.g., "2.0.0"
   - **NPM Package ID**: e.g., "hl7.fhir.uv.ips" (optional - can be auto-generated)
   - **Target Nodes**: Check which servers need this IG:
     - ☑ aucore (AU Core FHIR Server)
     - ☑ hl7au (HL7 AU Base Server)
     - ☐ ereq (eRequesting Server)
   - **Deployment Preferences**:
     - ☐ Request immediate deployment after change is approved and merged
   - **Business Justification**: Why you need this
   - **Acceptance Criteria**: How you'll verify it works

4. Submit the issue

#### Step 2: Automatic Validation (30 seconds)

The system automatically:
- ✅ Validates all required fields
- ✅ Runs a dry-run simulation
- ✅ Posts a preview comment showing what will happen

**Example preview comment:**
```markdown
## 🔍 Automated Validation & Preview

### ✅ Validation Passed

**IG Details:**
- Name: International Patient Summary
- Version: 2.0.0
- Package ID: hl7.fhir.uv.ips
- Target Nodes: aucore, hl7au

### 📦 Dry-Run Preview
✅ Dry-run completed successfully!
[Detailed output showing what packages will be installed]

### 📋 Next Steps
1. Review the dry-run output above
2. Verify the package ID is correct
3. Wait for repo admin to approve
```

#### Step 3: Admin Review & Approval

A repo admin will:
- Review your request
- Add technical details if needed
- Add the `ready-for-automation` label when approved

#### Step 4: Automatic PR Creation (1-2 minutes)

The system automatically:
- ✅ Creates a new Git branch
- ✅ Generates package JSON file
- ✅ Updates `simplified-multinode.yaml` for selected nodes
- ✅ Updates `terraform/main.tf` to reference the new package
- ✅ Creates a Pull Request
- ✅ Posts PR link to your issue

You'll receive a comment:
```markdown
🤖 Your Request is Being Processed

A Pull Request has been automatically generated: PR #45

### What was generated:
- ✅ Package file: package-ips-2.0.0.json
- ✅ Updated: simplified-multinode.yaml for aucore, hl7au
- ✅ Updated: terraform/main.tf

### Next Steps:
1. Repo admins will review the generated configuration
2. Once approved and merged, you'll be notified about deployment
```

#### Step 5: PR Review & Merge (Admins)

Repo admins will:
- Review the auto-generated code
- Verify configuration is correct
- Approve and merge the PR

#### Step 6: Deployment

**If you requested immediate deployment:**
```markdown
🚀 Your Deployment Request is Being Processed

PR #45 has been merged and your request for immediate deployment is being fulfilled.

You will receive another comment with deployment results.
```

**If you didn't request immediate deployment:**
```markdown
## ✅ PR #45 Merged - Deployment Options

Your requested changes have been approved and merged.

**Option A: Immediate Deployment**
A repo admin can deploy immediately (2-5 minutes, no downtime)

**Option B: Wait for Next Server Restart**
Changes apply automatically on next restart (zero risk, may take hours/days)

A repo admin will decide when to deploy based on urgency.
```

#### Step 7: Verification

After deployment, you'll receive:
```markdown
## ✅ Package Deployment Successful

Your requested packages have been deployed successfully!

Please verify the deployment:
1. Test that the IG packages are working as expected
2. Verify your acceptance criteria are met
3. Comment on this issue with verification results
```

Test and verify:
- Access the FHIR endpoints
- Validate resources against new profiles
- Confirm acceptance criteria

Comment with results:
```markdown
✅ Verified!
- IPS resources accessible at /fhir/StructureDefinition
- Validation working correctly
- Test data loaded successfully
All acceptance criteria met!
```

A repo admin will close the issue once confirmed.

---

## Test Data Management

Test data loading and clearing is powered by the [`sparked-test-data-loader`](https://github.com/aehrc/sparked-test-data-loader) Go tool.

### Common Operations (Manage Test Data Workflow)

For common multi-step operations, use the **Manage Test Data** workflow:

1. Go to **Actions** → **Manage Test Data**
2. Click **Run workflow**
3. Select an operation:

| Operation | What it does |
|-----------|-------------|
| `clear-and-load-aucore` | Wipe all + expunge aucore, then load test data |
| `clear-and-load-ereq` | Wipe all + expunge ereq, then load test data |
| `clear-and-load-aucore-and-ereq` | Clear + load both nodes in parallel |
| `clear-and-expunge` | Wipe all + expunge a selected node (no reload) |

4. Optionally enable **Dry Run** to preview changes
5. Click **Run workflow**

### Loading Test Data

#### Via Workflow (Quick)

1. Go to **Actions** → **Load Test Data** → **Run workflow**
2. Select target node, upload method, and options
3. Click **Run workflow**

#### Via Issue Request

1. Go to [Issues → New Issue](../../issues/new/choose)
2. Select **"Operational Request"**
3. Fill out:
   - **Operation Type**: Load test data
   - **Data Source**: URL to test data repository
   - **Upload Mode**: individual or transaction
   - **Business Justification**: Why you need this data
4. Admin approves (`status:approved` label)
5. Data loads automatically via the `sparked-test-data-loader` tool

#### Verification

You'll receive:
```markdown
Test Data Load Complete

- Total Files: 150
- Succeeded: 148
- Failed: 2
- Duration: 120s

Please verify the data has been loaded as expected.
```

### Clearing Test Data

1. Go to **Actions** → **Clear Test Data** → **Run workflow**
2. Select:
   - **Delete mode**: `targeted` (match test data files) or `wipe-all` (everything)
   - **Target node**: aucore, hl7au, ereq
   - **Expunge**: Enable for physical removal (not just soft-delete)
3. Click **Run workflow**

### Local CLI Usage

See [scripts/README.md](../scripts/README.md) for local CLI examples including:
- Clear + expunge a node
- Clear + reload AU Core or eRequesting data
- Load to multiple nodes
- Dry run previews

---

## SMART Client Registration

Register SMART on FHIR / OIDC clients on the aucore node for app developers and connectathon participants.

See the **[SMART App Registration Guide](SMART-APP-REGISTRATION.md)** for full details.

### Quick Start (Requestors)

**Goal:** Register a SMART on FHIR client on the aucore node

**Time:** ~5 minutes (automated)

#### Step 1: Create Issue

1. Go to [Issues > New Issue](../../issues/new/choose)
2. Select **"SMART App Client Registration"**
3. Fill out:
   - **Client ID**: Unique identifier (e.g., `my-smart-app`)
   - **Client Name**: Human-readable name
   - **Client Type**: SMART App Launch (for interactive apps) or Backend Service (for server-to-server)
   - **Redirect URIs**: Your app's callback URLs (SMART App Launch only)
   - **Scopes**: Space-separated scopes
4. Submit the issue

#### Step 2: Admin Review & Approval

Admin reviews and adds `ready-for-automation` label.

#### Step 3: Automated Registration

- Client is registered via the SmileCDR Admin JSON API (~1 minute)
- Results with endpoint URLs posted to your issue
- For Backend Service clients, the secret is communicated out-of-band

### Connectathon Bulk Registration

For connectathon events with many participants:

1. Go to **Actions** > **Register SMART Clients** > **Run workflow**
2. Select mode: `bulk-connectathon`
3. Enable **Dry Run** first to preview
4. Run again without dry run to register all 10 pre-configured clients
5. Distribute client IDs to participants

Pre-configured clients are defined in `module-config/connectathon-clients.json`.

---

## Manual Package Deployment

### For Admins: Deploy Packages Manually

If you need to deploy packages outside of the automated workflow:

1. Go to **Actions** → **"Reload IG Packages for SmileCDR Nodes"**
2. Click **"Run workflow"**
3. Configure:
   - **Base URL**: `https://smile.sparked-fhir.com` (default)
   - **Nodes**: `aucore,hl7au` or `all`
   - **Package Source**:
     - `config` - Read from simplified-multinode.yaml (recommended)
     - `packages-dir` - Load all JSON files from packages/
     - `custom` - Provide custom JSON
   - **Dry Run**: `true` (test first) or `false` (deploy)
   - **Force Reinstall**: `false` (skip installed) or `true` (reinstall all)
4. Click **"Run workflow"**

The workflow will:
- Read package configurations
- Compare with installed packages on each node
- Install/update packages as needed
- Post results (if issue number provided)

---

## For Requestors

### What You Can Request

| Request Type | Examples | Timeline |
|--------------|----------|----------|
| **IG Release** | Add IPS 3.0.0, Update AU Core | 1-2 weeks |
| **Configuration** | Enable subscriptions, Add endpoint | 1-3 weeks |
| **Operations** | Load test data, Refresh environment | Hours to days |

### Request Status Labels

Track your request through these stages:

- `needs-review` → Awaiting admin review
- `status:approved` → Approved, automation triggered
- `status:in-progress` → PR created, being reviewed
- `status:deploying` → Deployment in progress
- `status:deployed` → Deployed, awaiting your verification
- `status:complete` → Verified and closed

### Tips for Successful Requests

1. **Be specific** - Provide exact versions and package IDs when possible
2. **Explain why** - Clear business justification helps prioritization
3. **Select nodes carefully** - Only choose nodes that actually need the IG
4. **Request immediate deployment** - If you need it urgently and can verify immediately
5. **Verify promptly** - When deployment completes, test and report back quickly

---

## For Repo Admins

### Processing IG Release Requests

#### When a New Issue is Created

1. **Review the automated validation comment**
   - Check if all fields are valid
   - Review the dry-run preview
   - Verify package ID is correct

2. **Add technical details if needed**
   ```markdown
   ## Technical Implementation Plan

   **Estimated effort:** 30 minutes
   **Target completion:** 2025-11-20

   **Notes:**
   - Package ID auto-generated as hl7.fhir.uv.ips
   - Will update aucore and hl7au nodes
   - Standard configuration, no special requirements
   ```

3. **Approve for automation**
   - Add label: `ready-for-automation`
   - Workflow triggers automatically (~1 minute)

4. **Review the auto-generated PR**
   - Check package JSON file
   - Verify simplified-multinode.yaml updates
   - Confirm terraform/main.tf changes
   - Approve and merge

5. **Handle deployment**
   - **If `deploy-immediately` label**: Deployment triggers automatically
   - **If not**: Comment will be posted with deployment options for admin to choose

6. **Monitor and close**
   - Watch for requester verification
   - Close issue when confirmed working

### Processing Test Data Requests

1. **Review the request**
   - Verify data source is legitimate
   - Check upload mode makes sense
   - Confirm environment is correct

2. **Approve**
   - Add label: `status:approved`
   - Workflow triggers automatically

3. **Or use Manage Test Data workflow directly**
   - Go to **Actions** → **Manage Test Data** → **Run workflow**
   - Select the appropriate operation (e.g., `clear-and-load-aucore`)
   - Use dry run first to preview changes

4. **Monitor execution**
   - Check workflow logs and GitHub Actions step summary
   - Verify completion
   - Note: `vendor-demonstrator` folder is automatically excluded

5. **Confirm with requester**
   - Ask them to verify data loaded correctly
   - Close when confirmed

### Manual Deployment Scenarios

**When to use manual deployment:**
- Testing configuration changes
- Troubleshooting package issues
- Loading packages for multiple nodes at once
- Force reinstalling packages

**Steps:**
1. Go to Actions → "Reload IG Packages for SmileCDR Nodes"
2. Run workflow with appropriate settings
3. Monitor logs
4. Verify packages installed
5. Update related issue if applicable

### Troubleshooting

**Validation fails:**
- Check issue body formatting
- Ensure required fields are filled
- Verify node checkboxes are checked

**PR creation fails:**
- Check validation passed first
- Review workflow logs in Actions tab
- Verify simplified-multinode.yaml is valid YAML

**Deployment fails:**
- Check SmileCDR logs
- Verify network connectivity
- Confirm package exists in registry
- Try with `force_reinstall=true`

**Package not found:**
- Verify package name and version
- Check if package is in public registry
- May need custom `packageUrl`

---

## Workflow Reference

### Active Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ig-request-validation.yml` | Issue created/edited with `ig-release` label | Validates issue fields, runs dry-run preview |
| `issue-ig-pr-creator.yml` | Issue labeled `ready-for-automation` | Creates PR with package config changes |
| `issue-pr-merge-updater.yml` | PR merged | Posts deployment options or triggers auto-deployment |
| `reload-ig-config.yml` | Manual or workflow_call | Deploys packages to SmileCDR nodes |
| `load-test-data.yml` | Manual or workflow_call | Loads FHIR test data to a node |
| `clear-test-data.yml` | Manual or workflow_call | Clears FHIR test data from a node |
| `manage-test-data.yml` | Manual | Common multi-step operations (clear+load, expunge) |
| `register-smart-clients.yml` | Manual, workflow_call, or issue label | Registers SMART/OIDC clients on aucore node |

### Workflow Inputs

**reload-ig-config.yml:**
- `base_url`: SmileCDR base URL (default: https://smile.sparked-fhir.com)
- `nodes`: Comma-separated list or "all" (default: aucore)
- `package_source`: config, packages-dir, or custom (default: config)
- `custom_packages`: JSON array of packages (for custom source)
- `dry_run`: true/false (default: true)
- `force_reinstall`: true/false (default: false)
- `issue_number`: Optional issue number to post results to

---

## Best Practices

### For Everyone

1. **Use dry-run first** - Always test before deploying
2. **Document everything** - Comment on issues with progress
3. **Verify changes** - Test and confirm before closing
4. **Follow the process** - Don't skip steps
5. **Communicate** - Update issues, post to Zulip when done

### For Requestors

1. **Provide complete information** - The more details, the faster the process
2. **Be available** - Respond to questions and verify deployments promptly
3. **Test in dev first** - Request dev deployment before production
4. **Use issue templates** - They ensure you don't miss required fields

### For Admins

1. **Respond quickly** - Acknowledge requests within 24 hours
2. **Use automation** - Let workflows do the repetitive work
3. **Review carefully** - Check auto-generated code before merging
4. **Test deployments** - Use dry-run mode first
5. **Keep requestors informed** - Comment on progress

---

## Support

- **Workflow Issues:** Check GitHub Actions logs
- **Script Issues:** Run locally with `--dry-run` flag
- **Questions:** Ask in team Zulip
- **Bugs:** Create an issue with label `bug`
- **Improvements:** Create an issue with label `enhancement`

---

**Ready to get started?**

👉 [Create an IG Release Request](../../issues/new/choose)
