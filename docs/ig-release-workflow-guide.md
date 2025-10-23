# Enhanced IG Release Workflow Guide

This guide explains the improved IG release workflow with node selection, validation, dry-run preview, and automated deployment options.

## Overview

The enhanced workflow provides:

1. **Node Selection** - Choose which SmileCDR nodes should receive the IG
2. **Automatic Validation** - Validates issue fields when created/edited
3. **Dry-Run Preview** - Shows what will happen before creating PR
4. **Approval Gate** - Manual review before PR creation
5. **Automated PR** - Generates PR with all necessary config changes
6. **Deployment Options** - Choose when and how to deploy after merge

## Workflow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User Creates IG Release Issue                            │
│    - Fills out IG details                                   │
│    - Selects target nodes (aucore, hl7au, ereq)            │
│    - Specifies package options                              │
└────────────────┬────────────────────────────────────────────┘
                 │ (Automatic)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Validation & Dry-Run Preview                             │
│    - Validates required fields                              │
│    - Runs sync_packages.py in dry-run mode                  │
│    - Posts preview comment to issue                         │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. User Reviews Preview                                     │
│    - Checks package details                                 │
│    - Verifies target nodes                                  │
│    - Reviews dry-run output                                 │
└────────────────┬────────────────────────────────────────────┘
                 │ (Manual)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. User Adds 'ready-for-automation' Label                   │
│    - Triggers PR generation                                 │
└────────────────┬────────────────────────────────────────────┘
                 │ (Automatic)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Auto-Generate PR                                         │
│    - Creates package JSON file                              │
│    - Updates simplified-multinode.yaml (selected nodes)     │
│    - Updates main.tf                                        │
│    - Creates PR with all changes                            │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. PR Review & Merge                                        │
│    - Team reviews changes                                   │
│    - Approves and merges                                    │
└────────────────┬────────────────────────────────────────────┘
                 │ (Automatic)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. Post-Merge: Deployment Options                           │
│    - Comment posted with 3 deployment options               │
│    - User chooses when to deploy                            │
└────────────────┬────────────────────────────────────────────┘
                 │ (User Choice)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Deploy & Verify                                          │
│    - Packages deployed to selected nodes                    │
│    - User verifies functionality                            │
│    - Issue closed when complete                             │
└─────────────────────────────────────────────────────────────┘
```

## Step-by-Step Guide

### Step 1: Create IG Release Issue

1. Go to **Issues** → **New Issue**
2. Select **Implementation Guide Release Request**
3. Fill out the form:

   **Required Fields:**
   - IG Name (e.g., "International Patient Summary")
   - IG Version (e.g., "2.0.0")
   - Urgency
   - Request Type (New/Update/Rollback)
   - Business Justification
   - Acceptance Criteria

   **Node Selection (Required):**
   ```
   ☑ aucore (AU Core FHIR Server)
   ☑ hl7au (HL7 AU Base Server)
   ☐ ereq (eRequesting Server)
   ```

   **Optional Fields:**
   - NPM Package ID (will be auto-generated if not provided)
   - IG URL
   - Test Data Requirements
   - Additional Context

   **Package Options:**
   ```
   ☐ Install this package automatically (STORE_AND_INSTALL)
   ☑ Fetch dependencies automatically
   ```

4. Click **Submit new issue**

### Step 2: Automatic Validation & Preview

Within 30 seconds of creating the issue, an automated comment will appear:

#### If Validation Passes:

```markdown
## 🔍 Automated Validation & Preview

### ✅ Validation Passed

**IG Details:**
- **Name**: International Patient Summary
- **Version**: 2.0.0
- **Package ID**: hl7.fhir.uv.ips
- **Install Mode**: STORE_ONLY
- **Fetch Dependencies**: true
- **Target Nodes**: aucore,hl7au

### 📦 Dry-Run Preview

✅ **Dry-run completed successfully!**

<details>
<summary>Click to view detailed dry-run output</summary>

```
SmileCDR Package Synchronization
===========================================
Base URL: https://smile.sparked-fhir.com
Target nodes: aucore, hl7au
...
```
</details>

### 📋 Next Steps

1. ✅ Review the dry-run output above
2. ✅ Verify the package ID is correct
3. ✅ Add the `ready-for-automation` label to trigger PR creation
```

#### If Validation Fails:

```markdown
## 🔍 Automated Validation & Preview

### ❌ Validation Failed

Please fix the following issues:

- ❌ IG Version is required
- ❌ At least one target node must be selected

💡 **Next Steps**: Update the issue with the required information
```

### Step 3: Review the Preview

1. **Check the package details** - Verify name, version, package ID
2. **Review target nodes** - Ensure correct nodes are selected
3. **Examine dry-run output** - Click to expand and review what will happen
4. **Verify package ID** - If auto-generated, make sure it's correct

**If changes are needed:**
- Edit the issue to update fields
- Validation will run automatically after editing
- New preview will be posted

**If everything looks good:**
- Proceed to next step

### Step 4: Approve for Automation

When ready to create the PR:

1. Click **Labels** on the right sidebar
2. Add the `ready-for-automation` label
3. The workflow will trigger automatically

### Step 5: PR Creation (Automatic)

Within 1-2 minutes, a pull request will be created:

**PR Title:**
```
Add International Patient Summary 2.0.0 to aucore,hl7au (Issue #123)
```

**PR Changes:**
1. ✅ Creates `module-config/packages/package-international-patient-summary-2.0.0.json`
2. ✅ Updates `simplified-multinode.yaml` for nodes: `aucore,hl7au`
3. ✅ Updates `main.tf` to reference new package

**PR Body includes:**
- IG details
- Target nodes
- Changes made
- Review checklist
- Rollback plan

### Step 6: Review & Merge the PR

1. **Review the PR changes**
   - Check the package JSON file
   - Verify simplified-multinode.yaml updates for each node
   - Confirm main.tf changes

2. **Run Terraform Plan** (optional)
   ```bash
   terraform plan
   ```

3. **Approve the PR**
   - Add your review
   - Approve if everything looks good

4. **Merge the PR**
   - Use "Squash and merge" or "Rebase and merge"

### Step 7: Post-Merge Deployment Options

After merging, a comment will be posted to both the PR and the original issue:

```markdown
## ✅ PR #45 Merged - Choose Deployment Method

### Option A: Automatic Deployment (Recommended)
👉 [Click here to deploy now]
- Select "Run workflow"
- Use default settings
- Set `dry_run=false`

### Option B: Wait for Next Server Restart
👉 No action needed

### Option C: Manual Deployment Later
👉 Bookmark the workflow link
```

**Choose the deployment option that fits your needs:**

#### Option A: Immediate Deployment (Recommended)

**When to use:**
- Need changes immediately
- Have time to verify now
- Want to test before announcing

**Steps:**
1. Click the workflow link
2. Click "Run workflow"
3. Configure:
   - `nodes`: `all` (or specific nodes)
   - `package_source`: `config`
   - `dry_run`: `false`
   - `force_reinstall`: `false`
4. Click "Run workflow"
5. Monitor the workflow logs
6. Verify packages are installed
7. Comment on the issue with verification results

#### Option B: Wait for Next Restart

**When to use:**
- Not urgent
- Want zero risk
- Prefer automated deployment

**Steps:**
- No action needed
- Changes will apply on next server restart
- Update issue when you notice deployment complete

#### Option C: Manual Later

**When to use:**
- Need to coordinate with testing
- Specific deployment window required
- Want to batch multiple changes

**Steps:**
1. Bookmark the workflow link
2. Run when ready (follow Option A steps)
3. Update issue when deployed

### Step 8: Verify Deployment

After deployment (by any method):

1. **Verify package installation:**
   ```bash
   # Check aucore node
   curl -H "Authorization: Basic $AUTH" \
     https://smile.sparked-fhir.com/aucore/package/npm/-/v1/search

   # Should show your new package
   ```

2. **Test IG functionality:**
   - Try loading resources
   - Validate against new profiles
   - Run acceptance criteria from issue

3. **Update the issue:**
   ```markdown
   ## ✅ Verification Complete

   Tested on: 2024-01-15

   - ✅ Package installed on aucore
   - ✅ Package installed on hl7au
   - ✅ Validation works correctly
   - ✅ Test data loads successfully

   All acceptance criteria met!
   ```

4. **Close the issue**

## Troubleshooting

### Validation Fails

**Problem:** "At least one target node must be selected"

**Solution:** Edit the issue and check at least one node checkbox

---

**Problem:** "Package ID auto-generated - please verify"

**Solution:** Check if the generated package ID is correct. Edit the issue to provide the correct NPM package ID if needed.

---

### Dry-Run Shows Errors

**Problem:** Dry-run fails with 401 Unauthorized

**Solution:** This is expected if the server requires authentication. The actual deployment uses credentials from secrets.

---

**Problem:** Dry-run shows "Package not found"

**Solution:** Verify:
- Package name is correct
- Version exists in the registry
- If using custom URL, provide it in "Additional Context"

---

### PR Creation Fails

**Problem:** "Missing required fields"

**Solution:** Check validation comment for details. Edit issue to fix, then try adding label again.

---

**Problem:** "No target nodes selected"

**Solution:** Edit the issue and select at least one node checkbox.

---

### Deployment Fails

**Problem:** Package installation times out

**Solution:**
- Larger packages may take longer
- Try running with `force_reinstall=false` first
- Check SmileCDR logs for details

---

**Problem:** Dependencies fail to fetch

**Solution:**
- Check network connectivity from SmileCDR to packages.fhir.org
- Try with `fetchDependencies: false` and install dependencies manually
- Provide custom `packageUrl` if package is not in public registry

## Advanced Usage

### Custom Package URLs

For packages not in the public registry:

1. Add to "Additional Context" in issue:
   ```
   Custom package URL: https://build.fhir.org/ig/HL7/fhir-ips/package.tgz
   ```

2. Maintainer will manually add `packageUrl` field to package JSON before merging PR

### Updating Existing Packages

1. Create issue with Request Type: "Update"
2. Specify new version
3. Select same nodes as before (or different if needed)
4. Workflow will handle version changes automatically

### Rollback

If deployment causes issues:

1. Create new issue with Request Type: "Rollback"
2. Specify previous version
3. Follow normal workflow
4. Old version will replace new version

### Multi-Environment Deployment

For dev → staging → prod promotions:

1. Deploy to dev first (lowest risk)
2. Test thoroughly
3. Create separate issues for staging and prod
4. Reference dev testing in justification

## Tips & Best Practices

1. **Always review the dry-run preview** - Catches issues early

2. **Verify package IDs** - Auto-generated IDs may not be correct for all packages

3. **Choose nodes carefully** - Consider which servers actually need the IG

4. **Test in dev first** - For production servers, test in development environment

5. **Update when deployed** - Keep the issue updated with deployment status

6. **Use immediate deployment** - For urgent changes or active testing

7. **Use restart deployment** - For non-urgent updates or low-risk changes

8. **Document verification** - Add verification results to the issue for audit trail

## See Also

- [Package Management Workflow](./package-management-workflow.md)
- [Manual IG Load Workflow](.github/workflows/manual-ig-load.yml)
- [Auto IG Release Workflow](.github/workflows/auto-ig-release.yml)
- [SmileCDR Documentation](https://smilecdr.com/docs/)
