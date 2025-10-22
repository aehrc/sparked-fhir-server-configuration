# Automation Guide - IG Release Requests


Will need to add some logic so that simplified multinode.yaml is also updated automatically in future....

This guide explains how to use the automated IG release workflow and helper scripts.

## Table of Contents

- [Overview](#overview)
- [Automated Workflow](#automated-workflow)
- [Manual Helper Script](#manual-helper-script)
- [Complete Process Flow](#complete-process-flow)
- [Troubleshooting](#troubleshooting)

## Overview

The IG release automation can create Pull Requests automatically from GitHub issues, saving time and ensuring consistency.

### What Gets Automated

When an IG release issue is approved, the automation:
1. ✅ Extracts IG name, version, and package ID from the issue
2. ✅ Creates a new Git branch
3. ✅ Generates `package-<name>-<version>.json` file
4. ✅ Updates `main.tf` to reference the new package
5. ✅ Creates a Pull Request with all changes
6. ✅ Comments on the original issue with PR link
7. ✅ Updates issue labels

### What Needs Manual Review

The automation generates the basics, but you should still:
- ⚠️  Verify the package ID is correct
- ⚠️  Check if `simplified-multinode.yaml` needs updates
- ⚠️  Review terraform plan output
- ⚠️  Ensure test data requirements are addressed

## Automated Workflow

### How to Trigger

There are two ways to trigger automated PR generation:

#### Method 1: Label-Based (Recommended)

1. User creates IG release issue
2. You review the issue and ensure it has:
   - IG Name
   - IG Version
   - Optionally: NPM Package ID
3. Add the label `ready-for-automation` to the issue
4. Wait 30-60 seconds for the workflow to run
5. Check the issue for a comment with the PR link

#### Method 2: Manual Trigger

If the label doesn't trigger it, or you want to retry:

1. Go to Actions → "Auto-Generate IG Release PR"
2. Click "Run workflow"
3. Enter the issue number
4. Click "Run workflow"

### Expected Behavior

**Success Case:**
```
📋 Issue #42 labeled with 'ready-for-automation'
    ↓
🤖 Workflow runs (30-60 seconds)
    ↓
✅ PR #43 created automatically
    ↓
💬 Comment posted on Issue #42 with PR link
    ↓
🏷️  Labels updated:
    - Removed: ready-for-automation
    - Added: auto-pr-created, status:in-progress
```

**Failure Case:**
```
📋 Issue #42 labeled with 'ready-for-automation'
    ↓
🤖 Workflow runs
    ↓
❌ Error encountered
    ↓
💬 Failure comment posted on Issue #42
    ↓
🏷️  Labels updated:
    - Removed: ready-for-automation
    - Added: needs-manual-intervention
```

### Generated PR Structure

The automated PR includes:

**Files Changed:**
- `module-config/packages/package-<name>-<version>.json` (new)
- `main.tf` (modified to reference new package)

**PR Description:**
- IG details extracted from issue
- Checklist for manual review
- Link back to original issue
- Rollback instructions
- Closes #<issue-number> (auto-closes issue when merged)

### Reviewing Automated PRs

When you receive an automated PR:

1. **Check the Files tab**
   ```bash
   # Verify package file is correct
   cat module-config/packages/package-<name>-<version>.json

   # Should show:
   {
     "name": "hl7.fhir.uv.ips",  # Verify this is correct!
     "version": "3.0.0"
   }
   ```

2. **Check main.tf Changes**
   - Verify the package reference was added correctly
   - Ensure no unintended changes

3. **Check if simplified-multinode.yaml Needs Updates**
   - If this is a new IG requiring a new module, update manually
   - If updating an existing IG, check version references

4. **Review Terraform Plan**
   - Wait for the Terraform workflow to run
   - Check the plan output in the PR comments
   - Verify expected resources will be created/updated

5. **Approve and Merge**
   - If everything looks good, approve the PR
   - Merge to main
   - Terraform apply will run automatically

## Manual Helper Script

For more control or when automation fails, use the helper script.

### Prerequisites

```bash
# Install GitHub CLI if not already installed
brew install gh

# Or: https://cli.github.com/

# Authenticate
gh auth login
```

### Usage

```bash
# Navigate to repo
cd /path/to/sparked-fhir-server-configuration

# Run helper script with issue number
./.github/scripts/generate-ig-pr.sh 42
```

### Interactive Prompts

The script will:

1. **Fetch issue details** from GitHub
   ```
   📋 Fetching issue #42...
   ```

2. **Extract information** from issue body
   ```
   📦 Extracted Information:
     IG Name: International Patient Summary
     Version: 3.0.0
     Package ID: <not provided>
     Type: Update - Upgrading existing IG to new version
   ```

3. **Prompt for missing info** (if needed)
   ```
   ⚠️  No NPM Package ID provided in issue.
   Enter NPM Package ID (e.g., hl7.fhir.uv.ips): _
   ```

4. **Ask for confirmation**
   ```
   Continue with PR generation? (y/N): _
   ```

5. **Generate everything**
   ```
   🌿 Creating branch: ig-release/issue-42-ips-3.0.0
   📄 Creating package file...
   📝 Adding package reference to main.tf...
   💾 Committing changes...
   🚀 Pushing branch...
   📬 Creating Pull Request...
   ✅ Pull Request created: https://github.com/...
   ```

### What the Script Does

1. Creates branch: `ig-release/issue-<num>-<name>-<version>`
2. Creates package JSON file
3. Updates main.tf
4. Commits with proper message
5. Pushes branch
6. Creates PR
7. Comments on original issue
8. Updates labels

### Example Run

```bash
$ ./.github/scripts/generate-ig-pr.sh 42

📋 Fetching issue #42...

📦 Extracted Information:
  IG Name: International Patient Summary
  Version: 3.0.0
  Package ID: hl7.fhir.uv.ips
  Type: Update - Upgrading existing IG to new version

🔧 Generated Names:
  Branch: ig-release/issue-42-international-patient-summary-3.0.0
  Package File: package-international-patient-summary-3.0.0.json

Continue with PR generation? (y/N): y

🌿 Creating branch: ig-release/issue-42-international-patient-summary-3.0.0
📄 Creating package file...
✅ Created: module-config/packages/package-international-patient-summary-3.0.0.json
{
  "name": "hl7.fhir.uv.ips",
  "version": "3.0.0"
}

🔍 Checking main.tf...
📝 Adding package reference to main.tf...
✅ Updated main.tf

🔧 Formatting Terraform...
💾 Committing changes...
🚀 Pushing branch...
📬 Creating Pull Request...
✅ Pull Request created: https://github.com/aehrc/sparked-fhir-server-configuration/pull/43

💬 Commenting on issue...
🏷️  Updating issue labels...

🎉 Done!

Summary:
  Issue: #42
  Branch: ig-release/issue-42-international-patient-summary-3.0.0
  PR: https://github.com/aehrc/sparked-fhir-server-configuration/pull/43

Next: Review and merge the PR to deploy the IG!
```

## Complete Process Flow

### End-to-End: From Issue to Deployment

#### 1. Issue Creation (User)
```
User creates issue using "IG Release Request" template
  ↓
Fills in: IG Name, Version, Justification, etc.
  ↓
Submits issue
  ↓
Automated comment appears with next steps
```

#### 2. Initial Review (You)
```
Review issue for completeness
  ↓
Verify NPM package ID is provided or can be determined
  ↓
Add comment with technical details if needed
  ↓
Decision: Automate or Manual?
```

#### 3a. Automated Path
```
Add label: ready-for-automation
  ↓
Workflow runs automatically (~1 minute)
  ↓
PR created automatically
  ↓
Review automated PR
  ↓
Make manual adjustments if needed (simplified-multinode.yaml)
  ↓
Approve PR
```

#### 3b. Manual Path (Using Script)
```
Run: ./.github/scripts/generate-ig-pr.sh <issue-number>
  ↓
Provide missing info when prompted
  ↓
PR created
  ↓
Make additional changes to PR branch if needed
  ↓
Request review
```

#### 4. PR Review & Merge
```
Terraform workflow runs on PR
  ↓
Review terraform plan output
  ↓
Verify package ID is correct
  ↓
Check if simplified-multinode.yaml needs updates
  ↓
Approve PR
  ↓
Merge to main
```

#### 5. Deployment
```
Merge triggers Terraform apply on main
  ↓
Changes deployed to environment
  ↓
Verify deployment succeeded
  ↓
Comment on issue asking user to verify
  ↓
User verifies
  ↓
Close issue, notify on Zulip
```

## Troubleshooting

### Automation Doesn't Trigger

**Symptom**: Added `ready-for-automation` label but nothing happens

**Solutions**:
1. Check Actions tab - workflow may have failed
2. Try manual trigger:
   - Actions → "Auto-Generate IG Release PR"
   - Run workflow with issue number
3. Use helper script instead:
   ```bash
   ./.github/scripts/generate-ig-pr.sh <issue-number>
   ```

### Workflow Fails with "Missing Fields"

**Symptom**: Workflow runs but comments that fields are missing

**Solutions**:
1. Check issue body has properly formatted sections:
   ```markdown
   ### Implementation Guide Name
   International Patient Summary

   ### IG Version
   3.0.0
   ```
2. Fields must match template exactly (including capitalization)
3. If issue was edited, remove and re-add the label to re-trigger

### Package ID is Wrong

**Symptom**: Generated PR has incorrect NPM package ID

**Solutions**:
1. **Before merging**: Edit the package JSON file in the PR branch
   ```bash
   # Checkout the PR branch
   gh pr checkout <pr-number>

   # Edit the file
   vim module-config/packages/package-<name>.json

   # Update package ID
   {
     "name": "correct.package.id",  # Fix this
     "version": "3.0.0"
   }

   # Commit and push
   git add module-config/packages/package-<name>.json
   git commit -m "Fix package ID"
   git push
   ```

2. **Prevention**: Always provide NPM Package ID in the issue

### Main.tf Update Failed

**Symptom**: Package file created but main.tf not updated

**Solutions**:
1. Manually add the reference to main.tf in the PR:
   ```hcl
   helm_chart_mapped_files = [
     # ... existing packages ...
     {
       name     = "package-ips-3.0.0.json"
       location = "classes/config_seeding"
       data     = file("module-config/packages/package-ips-3.0.0.json")
     },
     # ... rest of files ...
   ]
   ```

### PR Created but Terraform Validation Fails

**Symptom**: PR exists but validation workflow fails

**Common Issues**:
1. **JSON syntax error** - Validate with `jq empty <file>`
2. **Terraform syntax error** - Run `terraform fmt` and `terraform validate`
3. **Missing file reference** - Ensure main.tf references the file

**Fix**:
```bash
# Checkout PR branch
gh pr checkout <pr-number>

# Fix issues
terraform fmt main.tf
jq . module-config/packages/package-*.json

# Commit fixes
git add .
git commit -m "Fix validation issues"
git push
```

### Need to Update simplified-multinode.yaml

**Symptom**: Package loaded but module not configured

**Solution**: Manually update in PR
```bash
gh pr checkout <pr-number>

# Edit simplified-multinode.yaml
vim module-config/simplified-multinode.yaml

# Add module configuration if needed
# Commit and push
git add module-config/simplified-multinode.yaml
git commit -m "Configure module in simplified-multinode.yaml"
git push
```

## Best Practices

### For Automation

1. **Always provide NPM Package ID in issues**
   - Saves time and prevents errors
   - Look it up on packages.fhir.org

2. **Review automated PRs immediately**
   - Don't let them sit
   - Check package ID first thing

3. **Test in dev first**
   - Always deploy to dev before production
   - Verify IG loads correctly

4. **Use consistent naming**
   - Helps automation generate better filenames
   - Follow existing package file naming patterns

### For Manual Script Usage

1. **Run from repo root**
   ```bash
   cd /path/to/sparked-fhir-server-configuration
   ./.github/scripts/generate-ig-pr.sh <issue>
   ```

2. **Have package ID ready**
   - Script will prompt if not in issue
   - Look it up beforehand to save time

3. **Check the generated PR**
   - Don't assume it's perfect
   - Review files before approving

## Advanced: Customizing the Automation

### Modify Package JSON Structure

Edit `.github/workflows/auto-ig-release.yml`:

```yaml
- name: Generate package JSON file
  run: |
    cat > "$PACKAGE_FILE" <<EOF
    {
      "name": "$PACKAGE_ID",
      "version": "${{ steps.issue.outputs.ig_version }}",
      "installMode": "STORE_AND_INSTALL",  # Add custom fields
      "fetchDependencies": true
    }
    EOF
```

### Add Additional Validations

```yaml
- name: Validate package exists on packages.fhir.org
  run: |
    PACKAGE_ID="${{ steps.issue.outputs.package_id }}"
    VERSION="${{ steps.issue.outputs.ig_version }}"

    curl -f "https://packages.fhir.org/$PACKAGE_ID/$VERSION" || {
      echo "Package not found on packages.fhir.org"
      exit 1
    }
```

### Auto-Update simplified-multinode.yaml

This is complex and depends on your module structure. For now, it's recommended to handle manually.

## Monitoring Automation Success

### Track Metrics

- **Success rate**: How many automated PRs are created successfully?
- **Time saved**: Compare manual vs automated
- **Error rate**: How often does automation fail?

### Suggested Dashboard

Track in a spreadsheet or tool:
- Date
- Issue Number
- Automation Used? (Yes/No)
- Success? (Yes/No)
- Time to PR (minutes)
- Time to merge (hours)

## Next Steps

After automation is working well:

1. **Add more validations** - Check package exists before creating PR
2. **Auto-update simplified-multinode.yaml** - Parse and update YAML safely
3. **Support multiple environments** - Auto-create PRs for dev, staging, prod
4. **Add test data automation** - Auto-load test data from issue requirements

---

**Questions?** Check [MAINTAINER_GUIDE.md](MAINTAINER_GUIDE.md) or ask in Teams!
