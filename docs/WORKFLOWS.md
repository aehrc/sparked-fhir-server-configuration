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

> This section covers one target: installing a package on the Sparked Dev FHIR Server.
> A published IG version also has to reach tx.dev, the test data and the Inferno test
> kits and platform. The end-to-end procedure, its ordering constraints and a
> per-release tracking issue are in
> **[runbooks/ig-release.md](runbooks/ig-release.md)** (maintainers).

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
   - **Target Nodes**: `aucore` (AU Core FHIR Server), the only node since the `ereq`
     and `hl7au` nodes were decommissioned on 2026-08-02
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
- Target Nodes: aucore

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
- ✅ Updated: simplified-multinode.yaml for aucore
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

The merge is the deploy. Nothing is dispatched at the merge; outside an event change freeze
the Argo CD Application `smilecdr` syncs `main` automatically and starts a new Smile pod
within about 2 minutes, and the new pod installs the packages from its seed config as it
starts. It can take up to 20 minutes to be ready, and the old pod serves until then
([runbook step 2.4](runbooks/ig-release.md#step-2-4)). In a freeze the automated sync is
held, so a merge ships only with a manual sync, or by itself when the freeze ends. After
the roll a repo admin runs the step 2.4 checks, including a read-only `Re/load IG
Packages` dry run that lists package drift both ways, runs it live only if that dry run
shows a missing version (never during the roll), and then labels the issue `deployed`.

#### Step 7: Verification

When the PR merges, you'll receive the notice below (a Terminology Content Change PR gets
a variant that says the merge changes nothing live, and a PR that changes both Smile and
terminology server files gets the notice below followed by the terminology hand steps):
```markdown
## PR #45 Merged Successfully

Your requested changes have been approved and merged into the main branch.

**What was merged:**
Add International Patient Summary 2.0.0 to aucore (Issue #42)

### The merge deploys it
Argo CD syncs the Smile workload (the `smilecdr` Application) from `main` on its own, so nobody needs to run anything:
- **Time**: outside an event change freeze, Argo CD starts a new Smile pod within about 2 minutes, and the new pod can take up to 20 minutes to be ready
- **Packages**: the new pod installs the packages from its seed config as it starts
- **Downtime**: none expected (the old pod serves until the new one is ready)

### After the roll
Once the roll has finished (one pod, Ready), a repo admin checks the node, including a read-only "Re/load IG Packages" dry run that lists package drift both ways, and then labels this issue `deployed`. A live "Re/load IG Packages" run follows only if the post-roll dry run shows a missing package version, and never during the roll: the new pod is already installing the same packages, and a second install stacked on top of it is unsafe.

### Event freezes
During an event change freeze the automated sync is held, so a merge to `module-config/` or `deploy/` ships only with a manual sync, or by itself when the freeze ends. That is why such merges are not made during a freeze, except a fix for an outage.

---

When this issue is labelled `deployed`, please verify the deployment meets your acceptance criteria and comment here with your results. A repo admin will then mark the issue as complete.

**Note**: Please do not close this issue manually. It will remain open for verification.
```

Once the issue is labelled `deployed`, test and verify:
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

### Notes: version bumps, custom package URLs, and batching

- **Version bumps replace in place.** When the request is an *Update*, the automation matches the existing package by its FHIR package **id** (not the filename) and swaps the version in `startup_installation_specs` in place, reusing the existing filename stem (e.g. `package-aucore-2.0.0.json` → `package-aucore-2.1.0-draft.json`). If the old package file ends up referenced by no node, it is deleted and its `values-common.yaml` / `terraform/main.tf` entries are removed automatically. A file still used by another node is kept (`aucore` is the only node today). Install order is preserved; packages are never re-sorted.
- **Custom Package URL.** Most IGs, including `-draft`/`-preview` versions, resolve from `packages.fhir.org` and need nothing extra. Use the template's **Custom Package URL** field only when a package is not on the registry or when a specific publication build must override a stale registry copy. (Tip: check existence with a GET, since `packages.fhir.org` returns 404 to `HEAD` requests.)
- **Batch related bumps into one issue/PR.** Separate IG issues each produce their own PR editing the same three files (`simplified-multinode.yaml`, `values-common.yaml`, `terraform/main.tf`), so two open at once will conflict on merge. For a coordinated set (e.g. AU Base + AU Core + IPS for a testing event), request them together or merge them one at a time, rebasing in between.

### Gotchas that have bitten IG releases

Each of these has happened on a real release. The runbook's
[gotchas reference](runbooks/ig-release.md#8-gotchas-reference) covers the Inferno side as
well, with the step each one bites in.

- **Tick "install automatically".** The box is unticked by default, and unticked writes
  `STORE_ONLY`: the package is stored but its conformance resources are not installed, so
  profile validation against the new version quietly stops (#84, #86).
  `scripts/apply_ig_release.py` also defaults to `STORE_ONLY`.
- **"Fetch dependencies" fetches nothing** once any version of a dependency is present, so
  it never upgrades one. Add a missing dependency version as its own pinned package, ahead
  of the IG (#86, #91, #92).
- **Superseded StructureDefinitions stay active** after a version bump. A version-less
  canonical can resolve to the old version, so verify with `profile=<url>|<version>` (#45).
- **Replacing a large package triggers a long expunge**: pod CPU near 1 core and
  intermittent 15 s ingress timeouts for several minutes. It recovers without a restart;
  do not stack another install on top (#92).
- **A live install is not persistent** until the deploy (the automatic sync of the
  Argo CD Application `smilecdr` that follows the merge) updates the seeded
  `startup_installation_specs`; a restart before that, or during a freeze that holds
  the sync, reseeds the old versions; see
  [runbook step 2.4](runbooks/ig-release.md#step-2-4).
- **Not during an event freeze.** No IG load, reload or apply while an event manifest's
  `freeze` window is open ([runbook constraint 9](runbooks/ig-release.md#4-ordering-constraints)).
  That includes merging an IG PR: the merge is the deploy, because the Argo CD
  Application `smilecdr` syncs `main` and rolls Smile within about two minutes
  ([runbook step 2.3](runbooks/ig-release.md#step-2-3)).
- **Nothing feeds tx.dev automatically.** The tx-dev fhir-ig-feeder was decommissioned
  on 2026-09-29 (`aehrc/sparked-argo` #285), so every IG version, not only AU PS, reaches
  tx.dev only once someone adds it to the `hl7au-dev` Atomio feed by hand
  ([runbook step 1.1](runbooks/ig-release.md#step-1-1)). Editing
  `terminology-servers/tx-dev-helm-values.yaml` no longer changes anything.

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
2. Select the target node and options
3. Click **Run workflow**

#### Via Issue Request

1. Go to [Issues → New Issue](../../issues/new/choose)
2. Select **"Operational Request"**
3. Fill out:
   - **Operation Type**: Load test data
   - **Data Source**: URL to test data repository
   - **Upload Mode**: individual or transaction
   - **Business Justification**: Why you need this data
4. Admin approves (`approved` label)
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
   - **Target node**: aucore, ereq
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

### User Management

SMART App Launch clients require user accounts for the authorization flow. Users are managed via the `manage_smart_users.py` script.

#### Create Connectathon Users (Bulk)

```bash
export CSIRO_FHIR_AUTH_64="your_credentials"

# Preview
python scripts/manage_smart_users.py \
  --bulk --users-file module-config/connectathon-users.json --dry-run

# Create all users
python scripts/manage_smart_users.py \
  --bulk --users-file module-config/connectathon-users.json
```

Pre-configured users are defined in `module-config/connectathon-users.json`.

#### Create a Single User

```bash
python scripts/manage_smart_users.py \
  --username participant-01 \
  --given-name Participant \
  --family-name One \
  --permissions read-only \
  --practitioner-id guthrie-aaron
```

Passwords are auto-generated and printed to the console. Distribute credentials securely to participants.

See **[SMART App Registration Guide](SMART-APP-REGISTRATION.md)** for full admin operations cheat sheet.

---

## Manual Package Deployment

### For Admins: Deploy Packages Manually

If you need to deploy packages outside of the automated workflow:

1. Go to **Actions** → **"Reload IG Packages for SmileCDR Nodes"**
2. Click **"Run workflow"**
3. Configure:
   - **Base URL**: `https://smile.sparked-fhir.com` (default)
   - **Nodes**: `aucore,ereq` or `all`
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
| **Terminology Content** | Watch a package on tx.dev / tx.hl7 | 1-2 weeks |
| **SMART App / OIDC** | Register a SMART on FHIR client | 1-3 business days |
| **General / Bug / Question** | Report a bug, ask a question, request a rollback | Best-effort |

See the [Service Catalogue](SERVICE-CATALOGUE.md) for the full menu, per-offering detail, and SLAs.

### Request Status Labels

Track your request through these stages:

- `needs-review` → Awaiting admin review
- `needs-revision` → Returned to you for changes before review continues
- `approved` → Approved, ready to implement
- `ready-for-automation` → Approved for automated PR generation
- `in-progress` → PR created, being reviewed
- `deployed` → Deployed, awaiting your verification
- `complete` → Verified and closed

### Tips for Successful Requests

1. **Be specific** - Provide exact versions and package IDs when possible
2. **Explain why** - Clear business justification helps prioritization
3. **Select nodes carefully** - Only choose nodes that actually need the IG
4. **Verify promptly** - When deployment completes, test and report back quickly

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
   - Will update aucore and ereq nodes
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

5. **Merge, then wait for the roll**
   - Merge outside an event freeze: the merge is the deploy, and Argo CD rolls Smile
     within about 2 minutes (up to 20 minutes for the new pod to be ready)
   - The new pod installs the packages from its seed config; do not run `Re/load IG
     Packages` during the roll
   - After the roll, run the step 2.4 checks, including a `Re/load IG Packages` dry run
     (`package_source: config`), which lists drift both ways; run it live, without
     `issue_number`, only if that dry run shows a missing version
     ([runbook step 2.4](runbooks/ig-release.md#step-2-4)). With `issue_number`, a
     successful live run labels the request `deployed` before the checks have run
   - Then, once the checks pass, mark the request deployed:
     `gh issue edit <N> --add-label deployed --remove-label in-progress`

6. **Monitor and close**
   - Watch for requester verification
   - Close issue when confirmed working
   - Tick the matching boxes on the IG version's
     [tracking issue](runbooks/ig-release.md#step-0-2), which carries the release on to
     test data and Inferno

### Processing Test Data Requests

1. **Review the request**
   - Verify data source is legitimate
   - Check upload mode makes sense
   - Confirm environment is correct

2. **Approve**
   - Add label: `approved`
   - Workflow triggers automatically

3. **Or use Manage Test Data workflow directly**
   - Go to **Actions** → **Manage Test Data** → **Run workflow**
   - Select the appropriate operation (e.g., `clear-and-load-aucore`)
   - Use dry run first to preview changes

4. **Monitor execution**
   - Check workflow logs and GitHub Actions step summary
   - Verify completion
   - Note: the `vendor-demonstrator` and `au-erequesting` folders are excluded by default; the Starting comment on the issue lists the folders a load skipped

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
1. Go to Actions → "Re/load IG Packages" (never while Argo CD is rolling Smile after a merge)
2. Run workflow with appropriate settings, dry run first
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

**Post-merge notice fails (`needs-manual-intervention` on the request):**
- `pr-merged.yml` could not post its notice; the merge itself still deployed whatever it
  changed under `module-config/` or `deploy/`
- Check the linked workflow run, then post the missing notice or a status update on the
  issue by hand
- The repo admin who posts that follow-up removes `needs-manual-intervention`
  (`gh issue edit <N> --remove-label needs-manual-intervention`); the issue then carries
  on as usual, with `deployed` added after the roll's checks

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
| `issue-opened.yml` (job: `validate-ig`) | Issue created/edited with `ig-release` label | Validates issue fields, runs dry-run preview |
| `issue-labeled.yml` (job: `create-ig-pr`) | Issue labeled `ready-for-automation` | Creates PR with package config changes |
| `pr-merged.yml` | PR merged | Posts the post-merge deployment notice (the merge is the deploy; nothing is dispatched) |
| `reload-ig-config.yml` | Manual or workflow_call | Re/loads packages on a running node; by hand, only after the post-merge roll |
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
