# Setup Complete - Request & Release System

This document summarizes the request/release system that has been set up for the Sparked FHIR Server Configuration repository.

## What Was Created

### 📋 GitHub Issue Templates (3)
Located in `.github/ISSUE_TEMPLATE/`

1. **[01-ig-release-request.yml](.github/ISSUE_TEMPLATE/01-ig-release-request.yml)**
   - For requesting new or updated FHIR Implementation Guides
   - Guided form with fields for IG name, version, environment, timeline
   - Includes fields for test data requirements and acceptance criteria
   - Non-technical user friendly

2. **[02-configuration-change.yml](.github/ISSUE_TEMPLATE/02-configuration-change.yml)**
   - For requesting server configuration changes
   - Covers module changes, endpoint updates, security changes
   - Includes impact analysis and rollback planning
   - Prompts for ADR consideration

3. **[03-operational-request.yml](.github/ISSUE_TEMPLATE/03-operational-request.yml)**
   - For operational tasks like data loading, expunge operations
   - Safety confirmation checkboxes for destructive operations
   - Includes automation request option
   - Frequency selection (one-time vs recurring)

### 🤖 GitHub Actions Workflows (2)
Located in `.github/workflows/`

1. **[validate-config.yml](.github/workflows/validate-config.yml)**
   - Runs on PRs and pushes to main
   - Validates YAML syntax (yamllint)
   - Validates Terraform configuration
   - Validates JSON package files
   - Checks for missing package file references
   - Security scanning with Trivy
   - Posts comments on PRs

2. **[issue-management.yml](.github/workflows/issue-management.yml)**
   - Automatically labels issues based on content
   - Posts helpful next-steps comments on new issues
   - Updates issues when status labels change
   - Extracts urgency and environment from issue body
   - Provides guidance specific to request type

### 📚 Documentation (3)
Located in `docs/`

1. **[USER_GUIDE.md](docs/USER_GUIDE.md)**
   - Comprehensive guide for non-technical users
   - Explains what can be requested
   - Step-by-step submission instructions
   - Complete example walkthrough (IPS 3.0.0 scenario)
   - Status label explanations
   - FAQ section
   - ~4,500 words

2. **[MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md)**
   - Technical guide for request processors
   - Implementation workflows for each request type
   - Common scenarios with code examples
   - Command reference
   - Safety guidelines
   - Communication best practices
   - ~3,000 words

3. **[README.md](README.md)** (Updated)
   - Added "Making Requests" section at the top
   - Quick start guide
   - Status label reference
   - Request type table with timelines
   - Development workflow documentation
   - Example: Adding IPS 3.0.0 package
   - Repository structure overview

### 🏷️ Label Configuration (2 files)
Located in `.github/`

1. **[labels.yml](.github/labels.yml)**
   - YAML definition of all labels
   - 27 labels covering:
     - Request types (ig-release, configuration, operations)
     - Status (needs-review, approved, in-progress, testing, complete)
     - Priority (critical, high, medium, low)
     - Environment (dev, staging, production)
     - Special (needs:adr, blocked, automation, etc.)

2. **[setup-labels.sh](.github/setup-labels.sh)** (Executable)
   - Shell script to create all labels via GitHub CLI
   - Creates labels with correct colors and descriptions
   - Can be re-run safely with --force flag

## Next Steps - Before Going Live

### 1. Push to GitHub
```bash
git add .
git commit -m "Add request & release system

- Add GitHub issue templates for IG releases, config changes, and operations
- Add GitHub Actions workflows for validation and issue management
- Add user guide for non-technical users
- Add maintainer guide for technical team
- Update README with request system documentation
- Add label configuration and setup script

This implements the request system discussed in stakeholder meeting."

git push origin main
```

### 2. Set Up GitHub Labels
```bash
cd .github
./setup-labels.sh
```

Or manually create labels from the GitHub UI using [labels.yml](.github/labels.yml) as reference.

### 3. Enable GitHub Actions
1. Go to repository Settings → Actions → General
2. Set "Actions permissions" to "Allow all actions and reusable workflows"
3. Set "Workflow permissions" to "Read and write permissions"
4. Check "Allow GitHub Actions to create and approve pull requests"

### 4. Test the System

**Create a test issue:**
```bash
# Via GitHub UI:
# 1. Go to Issues → New Issue
# 2. Select "Implementation Guide Release Request"
# 3. Fill out with test data
# 4. Verify automated comment appears
# 5. Verify labels are applied correctly

# Or via CLI:
gh issue create --template 01-ig-release-request.yml
```

**Create a test PR:**
```bash
# Make a small change
echo "# Test" >> test.txt
git add test.txt
git commit -m "Test PR for validation workflow"
git push origin test-branch

# Create PR
gh pr create --title "Test: Validation workflow"

# Verify:
# - Validation workflow runs
# - Comment appears on PR if validation passes
```

### 5. Announce to Team

**Post on Zulip:**
```
📢 New Request System for Sparked FHIR Server!

We now have a formal request system for FHIR server changes via GitHub Issues.

🎯 What you can request:
• Implementation Guide releases/updates
• Server configuration changes
• Data loading/expunge operations

📖 Get started:
• User Guide: [link to docs/USER_GUIDE.md]
• Submit request: [link to GitHub Issues]

Non-technical users welcome! The forms guide you through the process.

Questions? Check the User Guide or ask here!
```

**Update Confluence:**
- Link to the GitHub repository
- Link to USER_GUIDE.md
- Brief overview of request types
- Contact information for help

## Usage Examples

### Example 1: Your Supervisor's Request (IPS 3.0.0)

**Non-technical user submits:**
1. Goes to GitHub Issues → New Issue
2. Selects "Implementation Guide Release Request"
3. Fills in:
   - IG Name: International Patient Summary
   - Version: 3.0.0
   - Environment: Development
   - Justification: Needed for September 1-2 event
4. Submits

**You (maintainer) process:**
1. Review issue, see automated comment already posted
2. Add technical implementation notes (which files to change)
3. Create package file: `package-ips-3.0.0.json`
4. Update `main.tf` to reference it
5. Update `simplified-multinode.yaml` if needed
6. Create PR, deploy to dev
7. Ask requestor to verify
8. Close issue, announce on Zulip

**All tracked in GitHub issue with status labels!**

### Example 2: Content Team Needs Test Data

**Request:**
- Type: Operational Request
- Operation: Load test data
- Details: 50 patient records for testing sprint

**Process:**
1. Review request, verify environment (dev)
2. Load data via script/API
3. Update issue with results
4. Requestor verifies
5. Close issue

**Bonus:** If recurring, create GitHub Actions workflow for self-service!

## Benefits of This System

### For Non-Technical Users ✅
- No need to know file names or technical details
- Guided forms with helpful descriptions
- Track progress via status labels
- Get notified automatically

### For Technical Team ✅
- Centralized request tracking
- Standardized process
- Automated validations catch errors early
- Clear expectations and timelines
- Reusable implementation patterns

### For Stakeholders ✅
- Visibility into what's being worked on
- Clear status and priorities
- Documented justifications
- Tracked completion

## Customization

### Adding New Issue Templates

Create new YAML files in `.github/ISSUE_TEMPLATE/`:
```yaml
name: New Request Type
description: Description here
title: "[Label]: "
labels: ["custom-label"]
body:
  - type: input
    id: field-name
    attributes:
      label: Field Label
    validations:
      required: true
```

### Adding New Workflows

Create new YAML files in `.github/workflows/`:
```yaml
name: Workflow Name
on:
  workflow_dispatch:  # Manual trigger
jobs:
  job-name:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "Do something"
```

### Modifying Labels

Edit `.github/setup-labels.sh` and re-run:
```bash
cd .github
./setup-labels.sh
```

## Troubleshooting

### Workflows Not Running
- Check Settings → Actions → ensure actions are enabled
- Check workflow syntax with `yamllint .github/workflows/*.yml`

### Labels Not Applied Automatically
- Check `.github/workflows/issue-management.yml`
- Verify workflow has write permissions
- Check workflow run logs in Actions tab

### Validation Failing
- Check specific workflow run for error details
- Fix validation issues in code
- Re-run workflow from Actions tab

## Metrics to Track

**Consider tracking:**
- Number of requests by type
- Average time to completion
- Most common request types
- User satisfaction
- Blockers and delays

**GitHub provides:**
- Issue open/close metrics
- Label distribution
- Time in each status
- Response times

## Future Enhancements

**Possible additions:**
1. **Automated Deployments**
   - Auto-apply Terraform on merge
   - Environment promotion workflows

2. **Self-Service Operations**
   - On-demand test data loading
   - Scheduled expunge operations

3. **Integration**
   - Slack/Zulip notifications from GitHub Actions
   - Confluence page auto-updates

4. **Metrics Dashboard**
   - Request volume and trends
   - SLA tracking
   - Automated reporting

5. **Request Templates**
   - Pre-filled templates for common requests
   - Quick-start buttons for frequent operations

## Files Reference

### Created/Modified Files

```
sparked-fhir-server-configuration/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── 01-ig-release-request.yml       ✨ NEW
│   │   ├── 02-configuration-change.yml     ✨ NEW
│   │   └── 03-operational-request.yml      ✨ NEW
│   ├── workflows/
│   │   ├── validate-config.yml             ✨ NEW
│   │   └── issue-management.yml            ✨ NEW
│   ├── labels.yml                          ✨ NEW
│   └── setup-labels.sh                     ✨ NEW (executable)
├── docs/
│   ├── USER_GUIDE.md                       ✨ NEW
│   └── MAINTAINER_GUIDE.md                 ✨ NEW
├── README.md                               📝 UPDATED
└── SETUP_COMPLETE.md                       ✨ NEW (this file)
```

## Support

**For Users:**
- Read [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Create an issue with the "question" label
- Ask on Zulip

**For Maintainers:**
- Read [docs/MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md)
- Check previous similar issues
- Ask in Teams

---

## Ready to Launch! 🚀

The system is ready to use. Just:
1. Push to GitHub
2. Run setup-labels.sh
3. Enable GitHub Actions
4. Test with a sample issue
5. Announce to team

**Questions?** Check the guides or reach out on Teams!
