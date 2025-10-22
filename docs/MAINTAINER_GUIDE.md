# Maintainer Guide

**For Technical Team Members Managing Requests**

This guide explains how to process and implement requests submitted via GitHub Issues.

## Table of Contents

- [Initial Setup](#initial-setup)
- [Processing New Requests](#processing-new-requests)
- [Implementation Workflows](#implementation-workflows)
- [Common Scenarios](#common-scenarios)
- [Automation](#automation)

## Initial Setup

### One-Time GitHub Configuration

1. **Create Labels**
   ```bash
   cd .github
   ./setup-labels.sh
   ```
   This creates all the status, priority, and environment labels.

2. **Enable GitHub Actions**
   - Go to repository Settings → Actions → General
   - Enable "Allow all actions and reusable workflows"
   - The workflows will automatically run on PRs and issues

3. **Configure Notifications**
   - Watch the repository to get notified of new issues
   - Set up Zulip webhook for notifications (optional)

## Processing New Requests

### When a New Issue is Created

The system automatically:
- ✅ Posts a comment explaining next steps
- ✅ Adds initial labels based on urgency and environment
- ✅ Triggers validation workflows if PR is created

### Your Review Checklist

1. **Read the request thoroughly**
   - Understand what the user wants
   - Check if requirements are clear
   - Identify any missing information

2. **Add technical details**
   Comment on the issue with:
   ```markdown
   ## Technical Implementation Plan

   **Files to modify:**
   - `module-config/packages/package-name.json` - Create new package file
   - `main.tf` (lines 35-70) - Add package to helm_chart_mapped_files
   - `module-config/simplified-multinode.yaml` - Update module configuration

   **Database changes:**
   - None required

   **Estimated effort:**
   - 4 hours

   **Target completion:**
   - 2025-11-15

   **Testing plan:**
   - Deploy to dev
   - Verify package loads via logs
   - Test FHIR API queries for new resources

   **Risks/Dependencies:**
   - Requires latest Helm chart version
   ```

3. **Assess if ADR is needed**
   - New modules or endpoints → ADR likely needed
   - Simple package updates → Usually no ADR
   - Configuration changes affecting production → ADR needed
   - If ADR needed, add `needs:adr` label and create ADR

4. **Update labels**
   - Remove `needs-review`
   - Add `status:approved` (or `needs:adr`)
   - Confirm priority and environment labels are correct

## Implementation Workflows

### Workflow 1: IG Release Request

**Example**: User requests IPS v3.0.0

#### Step 1: Create Package File
```bash
# Create new package JSON
cat > module-config/packages/package-ips-3.0.0.json <<EOF
{
  "name": "hl7.fhir.uv.ips",
  "version": "3.0.0"
}
EOF

# Validate JSON
jq empty module-config/packages/package-ips-3.0.0.json
```

#### Step 2: Update main.tf
Add to `helm_chart_mapped_files` array (around line 34):
```hcl
{
  name     = "package-ips-3.0.0.json"
  location = "classes/config_seeding"
  data     = file("module-config/packages/package-ips-3.0.0.json")
}
```

Remove or update the old IPS package reference if upgrading.

#### Step 3: Update simplified-multinode.yaml (if needed)
Check if the IPS module needs configuration updates. Look for `package-ips` references.

Update to reference the new version if needed.

#### Step 4: Validate Configuration
```bash
# Validate Terraform
terraform init
terraform validate

# Validate YAML
yamllint module-config/*.yaml

# Validate all JSON packages
find module-config/packages -name "*.json" -exec jq empty {} \;
```

#### Step 5: Create PR
```bash
git checkout -b feature/issue-42-ips-3.0.0
git add module-config/packages/package-ips-3.0.0.json
git add main.tf
git add module-config/simplified-multinode.yaml  # if changed
git commit -m "Add IPS v3.0.0 package

Closes #42

- Created package-ips-3.0.0.json with NPM package details
- Updated main.tf to include new package file
- Updated simplified-multinode.yaml module configuration"

git push origin feature/issue-42-ips-3.0.0
```

#### Step 6: Create Pull Request
```bash
gh pr create --title "Add IPS v3.0.0 package (Issue #42)" \
  --body "## Summary
Implements Implementation Guide release request from issue #42.

## Changes
- Added package-ips-3.0.0.json
- Updated main.tf to reference new package
- Updated simplified-multinode.yaml for IPS module

## Testing
- [ ] Terraform validate passes
- [ ] YAML validation passes
- [ ] JSON validation passes
- [ ] Deploy to dev environment
- [ ] Verify package loads in Smile CDR logs
- [ ] Test FHIR queries for IPS resources

Closes #42"
```

#### Step 7: Deploy
After PR approval:
```bash
# Merge PR
gh pr merge --squash

# Deploy to dev
terraform plan -var-file=tfvars/dev.tfvars
terraform apply -var-file=tfvars/dev.tfvars

# Update issue
gh issue comment 42 --body "✅ Deployed to dev environment!

Please verify:
- IPS 3.0.0 resources available at https://dev.fhir.sparked.csiro.au/fhir
- Test queries: GET /fhir/StructureDefinition?url=http://hl7.org/fhir/uv/ips/*

Tagging @requestor for verification."

# Update labels
gh issue edit 42 --add-label "status:testing" --remove-label "status:in-progress"
```

#### Step 8: Verification & Completion
After requestor verifies:
```bash
# Update issue
gh issue comment 42 --body "✅ Verified by requestor. Closing issue.

Zulip notification sent to stakeholders."

# Update labels and close
gh issue edit 42 --add-label "status:complete" --remove-label "status:testing"
gh issue close 42
```

Post to Zulip:
```
🚀 IPS v3.0.0 Deployment Complete

The International Patient Summary (IPS) has been updated to version 3.0.0 on the dev environment.

- Issue: https://github.com/org/repo/issues/42
- Available at: https://dev.fhir.sparked.csiro.au/fhir
- Documentation: [link to Confluence]

Thanks to @requestor for the request!
```

### Workflow 2: Configuration Change

Similar to IG Release, but:
- May involve only `simplified-multinode.yaml` changes
- Check if ADR is needed
- May require database changes (add to `db_users` in main.tf)
- Test more thoroughly in dev before production

### Workflow 3: Operational Request (Data Load/Expunge)

**Example**: Load 50 test patients

#### For One-Time Operations
```bash
# Comment on issue first
gh issue comment 123 --body "Starting test data load operation.

**Details:**
- Environment: dev
- Operation: Load 50 synthetic patient records
- Source: S3 bucket s3://sparked-test-data/batch-001/
- Started: $(date)

Monitoring logs..."

# Perform operation (example using FHIR API)
# This is pseudocode - actual implementation depends on your tooling
./scripts/load-test-data.sh --env dev --count 50 --source s3://sparked-test-data/batch-001/

# Update issue with results
gh issue comment 123 --body "✅ Test data load complete!

**Results:**
- Loaded: 50 Patient resources
- Loaded: 150 related Observation resources
- Total resources: 200
- Completed: $(date)
- Duration: 5 minutes

Please verify by querying: GET /fhir/Patient?_tag=test-data"
```

#### For Recurring Operations (Create Workflow)
If user requests automation, create a GitHub Actions workflow:

```yaml
# .github/workflows/load-test-data.yml
name: Load Test Data

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - dev
          - staging
      count:
        description: 'Number of patients to load'
        required: true
        default: '50'

jobs:
  load-data:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Load test data
        run: |
          echo "Loading ${{ inputs.count }} patients to ${{ inputs.environment }}"
          # Your data loading logic here
```

## Common Scenarios

### Scenario 1: User Requests IPS 3.0.0 (Your Example)

**Issue #42: Add IPS v3.0.0**

1. ✅ Review issue, add implementation notes
2. ✅ Create `package-ips-3.0.0.json`
3. ✅ Update `main.tf` to reference new package
4. ✅ Check `simplified-multinode.yaml` for IPS module config
5. ✅ Validate, create PR, deploy to dev
6. ✅ User verifies, close issue, notify on Zulip

**Files changed:**
- `module-config/packages/package-ips-3.0.0.json` (new)
- `main.tf` (modified)
- `module-config/simplified-multinode.yaml` (potentially modified)

### Scenario 2: User Needs Subscription Module

**Issue #56: Enable FHIR Subscriptions**

This requires ADR because it's a new module with production impact.

1. ✅ Add `needs:adr` label
2. ✅ Create ADR document and route for approval
3. ⏳ Wait for ADR approval (1-2 weeks)
4. ✅ Update `simplified-multinode.yaml` to add subscription module
5. ✅ Test in dev thoroughly
6. ✅ Deploy to production after testing
7. ✅ Document new capability on Confluence

### Scenario 3: Expunge Test Data

**Issue #78: Delete July test data**

1. ✅ Verify scope - confirm it's test data, not production
2. ✅ Add `needs:verification` label
3. ✅ Comment asking user to confirm exact scope
4. ✅ User confirms
5. ✅ Schedule operation (off-hours if needed)
6. ✅ Notify user before starting
7. ✅ Run expunge operation
8. ✅ Verify and update issue

**Safety checks:**
- Confirm environment (dev vs production)
- Verify resource identifiers (test vs real)
- Take backup if needed
- Run in off-hours for production

## Automation

### Automated Validations (Already Active)

The `.github/workflows/validate-config.yml` workflow automatically:
- ✅ Validates YAML syntax
- ✅ Validates Terraform configuration
- ✅ Validates JSON package files
- ✅ Checks for package file references
- ✅ Security scans

### Issue Management (Already Active)

The `.github/workflows/issue-management.yml` workflow automatically:
- ✅ Adds priority labels based on urgency
- ✅ Adds environment labels
- ✅ Posts initial comment with next steps
- ✅ Posts updates when status changes

### Future Automation Ideas

**Self-Service Operations:**
- Create workflow_dispatch workflows for common operations
- Load test data on-demand
- Expunge operations with safety checks
- Environment refresh

**Terraform Automation:**
- Auto-plan on PRs
- Auto-apply on merge to main (with approval)
- Drift detection

## Tips & Best Practices

### Communication

**Be Responsive:**
- Acknowledge new issues within 24 hours
- Provide realistic timelines
- Update issues as you progress

**Be Clear:**
- Use non-technical language when talking to users
- Explain what you're doing and why
- Provide verification instructions

**Be Transparent:**
- Document blockers
- Explain delays
- Share lessons learned

### Safety

**Always:**
- Validate before deploying
- Test in dev first
- Take backups for destructive operations
- Get confirmation for production changes

**Never:**
- Deploy directly to production without testing
- Skip ADR for significant changes
- Delete data without confirmation
- Assume scope - ask for clarification

### Efficiency

**Use Templates:**
- Copy implementation notes from previous similar issues
- Reuse PR descriptions
- Standardize commit messages

**Batch Work:**
- Group similar requests
- Deploy multiple changes together (when safe)
- Update documentation in batches

## Getting Help

**For Questions:**
- Check previous similar issues
- Ask in Teams channel
- Review Smile CDR documentation

**For Approvals:**
- DTR and Brett Esler for ADRs
- Team lead for production deployments
- Security team for security-related changes

## Quick Reference

### Common Commands

```bash
# Validate everything
terraform validate && yamllint module-config/*.yaml && find module-config/packages -name "*.json" -exec jq empty {} \;

# Create feature branch
git checkout -b feature/issue-<number>-<short-description>

# Commit referencing issue
git commit -m "Description

Closes #<number>"

# Create PR
gh pr create --title "Title (Issue #<number>)" --body "..."

# Update issue
gh issue comment <number> --body "Message"
gh issue edit <number> --add-label "label" --remove-label "old-label"
gh issue close <number>

# Deploy
terraform plan -var-file=tfvars/dev.tfvars
terraform apply -var-file=tfvars/dev.tfvars
```

### Label Workflow

1. New issue: `needs-review` (auto-added)
2. Review complete: Remove `needs-review`, add `status:approved` or `needs:adr`
3. Start work: Add `status:in-progress`
4. Deploy to test: Add `status:testing`, remove `status:in-progress`
5. Complete: Add `status:complete`, remove `status:testing`, close issue

### Issue Templates Quick Ref

- **IG Release**: New/updated FHIR specs → Changes to packages/ and main.tf
- **Configuration**: Server behavior changes → Changes to simplified-multinode.yaml
- **Operations**: Data tasks → Scripts/manual operations, no code changes usually

---

**Questions?** Ask in Teams or update this guide!
