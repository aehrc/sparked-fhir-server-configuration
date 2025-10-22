# Sparked FHIR Server - User Guide

**For Content Teams and Non-Technical Users**

This guide explains how to request changes to the Sparked FHIR Server without needing technical knowledge.

## Table of Contents

- [What Can I Request?](#what-can-i-request)
- [How to Submit a Request](#how-to-submit-a-request)
- [Request Types Explained](#request-types-explained)
- [Example: Updating an Implementation Guide](#example-updating-an-implementation-guide)
- [Understanding Status Labels](#understanding-status-labels)
- [Getting Help](#getting-help)

## What Can I Request?

You can request three main types of changes:

### 1. Implementation Guide (IG) Releases
**When to use**: You want to add a new FHIR specification or update an existing one to a new version.

**Examples**:
- "I need the latest International Patient Summary (IPS) version 3.0.0"
- "Add AU eRequesting 2.0 to the server"
- "Update AU Core from 4.0 to 4.1"

### 2. Configuration Changes
**When to use**: You need to change how the server works or add new capabilities.

**Examples**:
- "Enable FHIR subscriptions for real-time notifications"
- "Add a new FHIR endpoint for a specific project"
- "Change security settings for an endpoint"

### 3. Operational Requests
**When to use**: You need data loaded, deleted, or maintenance performed.

**Examples**:
- "Load 50 test patient records for testing"
- "Delete all test data from last month"
- "Refresh the development environment with clean data"

## How to Submit a Request

### Step 1: Go to GitHub Issues
1. Navigate to this repository on GitHub
2. Click the **"Issues"** tab
3. Click the green **"New issue"** button

### Step 2: Choose a Template
You'll see three templates - pick the one that matches your need:
- **Implementation Guide Release Request** - For adding/updating FHIR specs
- **Configuration Change Request** - For changing server behavior
- **Operational Request** - For data operations

### Step 3: Fill Out the Form
The form will ask you questions. **Don't worry if you can't answer everything!**

**Required fields** are marked with a red asterisk (*). Fill these out as best as you can.

**Technical fields** can often be left blank - the technical team will fill them in.

### Step 4: Submit
Click **"Submit new issue"** at the bottom.

You'll automatically get a comment explaining what happens next!

## Request Types Explained

### Implementation Guide Release Request

This is for when you need a FHIR specification added or updated.

#### What You'll Need to Know

**Required Information**:
- **IG Name**: The name of the specification (e.g., "International Patient Summary")
- **Version**: Which version you need (e.g., "3.0.0")
- **Environment**: Where it should go (usually "Development" first, then "Production")
- **Why you need it**: Brief explanation of the use case
- **How to verify it works**: What you'll test to confirm it's working

**Optional (but helpful)**:
- **NPM Package ID**: Technical identifier (like "hl7.fhir.uv.ips") - only if you know it
- **Link to documentation**: URL to the IG specification
- **Test data needs**: If you need sample data loaded
- **Timeline**: When you need it by

#### Example Scenario

**Your supervisor says**: "We need to load the latest IPS package release, version 3.0.0, for the upcoming project starting in September."

**You would**:
1. Create an "Implementation Guide Release Request"
2. Fill in:
   - IG Name: `International Patient Summary`
   - Version: `3.0.0`
   - NPM Package ID: `hl7.fhir.uv.ips` (if you know it, otherwise leave blank)
   - Environment: `Development` (to test first)
   - Urgency: `Medium - Needed within 2 weeks`
   - Business Justification: `Needed for cross-border data exchange project starting September 1st`
   - Acceptance Criteria: `Can retrieve IPS resources via FHIR API, test data validates correctly`

**What happens behind the scenes** (you don't need to do this):
The technical team will:
1. Create/update a package file in `module-config/packages/package-ips-3.0.0.json`
2. Update `main.tf` to reference the new package
3. Update `simplified-multinode.yaml` if needed for the new module
4. Deploy the changes
5. Notify you when it's ready to test

### Configuration Change Request

This is for when the server needs to work differently or support new capabilities.

#### What You'll Need to Know

**Required Information**:
- **What's currently happening**: Describe the current behavior
- **What you want to happen**: Describe the desired behavior
- **Why**: Business justification for the change
- **How to test it**: How to verify the change works

**The technical team will figure out**:
- Which configuration files need to change
- If database changes are needed
- If this needs special approval (ADR)

#### Example Scenario

**Your team says**: "We need to be notified in real-time when certain FHIR resources are created or updated."

**You would**:
1. Create a "Configuration Change Request"
2. Fill in:
   - Change Type: `New FHIR module/endpoint`
   - Current State: `We only receive FHIR resources when we query for them`
   - Desired State: `We want to subscribe to resource changes and receive notifications automatically`
   - Business Justification: `The alerting system needs real-time updates when high-priority observations are created`
   - Testing Plan: `Create a test subscription, add a matching resource, verify we receive notification`

### Operational Request

This is for day-to-day operations like loading or deleting data.

#### What You'll Need to Know

**Required Information**:
- **Operation type**: What needs to be done (load, delete, refresh, etc.)
- **Environment**: Which server (dev, staging, production)
- **Details**: Specifics about the operation
- **Why**: Business justification
- **How to verify**: How to confirm it worked

#### Example Scenario

**Your team needs**: "50 test patient records for next week's testing sprint"

**You would**:
1. Create an "Operational Request"
2. Fill in:
   - Operation Type: `Load test data`
   - Environment: `Development (dev)`
   - Urgency: `Medium - Needed within 2 weeks`
   - Operation Details: `Load 50 synthetic patient records with IPS documents, conforming to AU Core profiles`
   - Frequency: `One-time operation`
   - Business Justification: `Testing sprint starts next Monday, need fresh test data`
   - Verification Plan: `Query for loaded patients, verify count is 50, spot-check data quality`

## Understanding Status Labels

After you submit a request, you'll see labels that show its status:

| Label | Meaning | What's Happening |
|-------|---------|------------------|
| `needs-review` | Awaiting review | Your request is in the queue, waiting for team to review |
| `priority:critical` | Critical urgency | Blocking work, will be prioritized |
| `priority:high` | High urgency | Needed within 1 week |
| `priority:medium` | Medium urgency | Needed within 2 weeks |
| `needs:adr` | Needs approval | Requires Architecture Decision Record approval |
| `status:approved` | Approved | Request approved, ready to implement |
| `status:in-progress` | In progress | Team is actively working on this |
| `status:testing` | Testing | Changes deployed, being tested |
| `status:complete` | Complete | Done! Please verify and close if satisfied |
| `blocked` | Blocked | Something is preventing progress (see comments) |
| `env:dev` | Development | For dev environment |
| `env:production` | Production | For production environment |

## What Happens After You Submit?

### Automated Response
Within seconds, you'll get an automated comment explaining the next steps for your request type.

### Technical Review
The team will:
1. Review your request
2. Add technical details and implementation notes
3. Estimate effort and timeline
4. Update labels to show progress

### You'll Be Notified When:
- Your request is approved
- Work starts (status changes to `in-progress`)
- Changes are deployed to test environment
- **You need to verify it works**
- Work is complete

### Where You'll Be Notified:
- **GitHub**: Comments on your issue
- **Zulip**: Announcement when deployment is complete
- **Email**: If you're watching the issue (GitHub notifications)

## Tips for Non-Technical Users

### You Don't Need to Know:
- File names or paths (like `main.tf` or `simplified-multinode.yaml`)
- Technical commands or code
- Infrastructure details
- Deployment processes

### You DO Need to Know:
- **What** you want to accomplish
- **Why** you need it (business justification)
- **When** you need it by
- **How** you'll verify it works

### If You're Unsure:
- **Fill out what you can** - The team will ask for clarification if needed
- **Provide context** - More context is better than too little
- **Ask questions** - Comment on the issue if you're confused
- **Include links** - Link to documentation, specs, or related work

## Common Questions

### Q: What if I don't know the technical name of an Implementation Guide?
**A**: Just describe it in plain language! For example: "The Australian eRequesting specification" or "The new version of patient summaries." Include a link to the documentation if you have it.

### Q: How do I know what version number to request?
**A**: Check the official documentation for the IG or specification. If you're unsure, describe what features you need and ask the team in the issue.

### Q: What if I need this urgently?
**A**: Select the appropriate urgency level and explain why in the business justification. For truly critical/blocking issues, also mention it on Zulip or Teams.

### Q: Can I request changes for production directly?
**A**: Generally, changes should be tested in development first. If you need production changes, explain why in your request and the team will guide the process.

### Q: What if I'm not sure which request type to use?
**A**: Start with the one that seems closest. The team can re-categorize if needed. You can also create a blank issue and ask!

### Q: How long will my request take?
**A**: It depends on complexity and urgency:
- Simple operations (data load): Hours to days
- IG releases: Days to 1-2 weeks
- Complex configuration changes: 1-3 weeks
- Changes requiring ADR approval: Add 1-2 weeks for approval process

### Q: Who can submit requests?
**A**: Anyone on the Sparked team! If you're unsure whether your request is appropriate, ask your team lead or post in Zulip first.

## Getting Help

### Need Help Submitting a Request?
- **Ask in Zulip**: Sparked channels
- **Comment on this repo**: Create a blank issue asking for help
- **Teams**: Message the technical team directly

### Request Not Moving Forward?
- **Check the labels**: They tell you the current status
- **Read the comments**: The team will explain any delays or blockers
- **Ask for an update**: Comment on your issue asking for status

### Something Broke After Deployment?
- **Comment on the original issue**: Describe what's not working
- **Create a new issue**: If it's a new problem
- **Notify on Zulip**: For urgent production issues

## Example: Complete Workflow

Let's walk through a complete example from start to finish.

### Scenario
Your supervisor asks you to load the latest International Patient Summary (IPS) specification, version 3.0.0, because the team will start a new project in September that requires it.

### Step-by-Step

#### 1. Create the Issue
- Go to GitHub Issues → New Issue
- Select "Implementation Guide Release Request"

#### 2. Fill Out the Form
```
IG Name: International Patient Summary
Version: 3.0.0
NPM Package ID: (leave blank if unsure)
IG URL: https://hl7.org/fhir/uv/ips/
Environment: Development
Urgency: Medium - Needed within 2 weeks
Timeline: 2025-08-20
Request Type: Update - Upgrading existing IG to new version
Business Justification: Required for cross-border data exchange pilot
  project starting September 1st, 2025. Current version (2.0.0-ballot)
  is missing features we need.
Test Data: Need 10-20 sample IPS documents for testing
Acceptance Criteria:
  - Can retrieve IPS 3.0.0 StructureDefinitions via FHIR API
  - Sample test documents validate against new profiles
  - Documentation shows IPS 3.0.0 is available
Stakeholders:
  - Requestor: @yourname
  - Notify: Sparked content team on Zulip
```

#### 3. Submit and Wait for Automated Response
You'll get a comment within seconds explaining next steps.

#### 4. Technical Team Reviews (1-2 days)
Team adds comments like:
```
Technical Implementation Notes:
- Update package-ips-3.0.0.json with NPM package details
- Modify main.tf to reference new package file
- Check if simplified-multinode.yaml needs ips module updates
- Estimated effort: 4 hours
- Target completion: 2025-08-18
```

Labels change: `needs-review` → `status:approved`

#### 5. Implementation (2-3 days)
Label changes to `status:in-progress`

Team comments with updates as work proceeds.

#### 6. Testing
Label changes to `status:testing`

Team comments:
```
Changes deployed to dev environment. Please verify:
- IPS 3.0.0 resources available at https://dev.fhir.sparked.csiro.au/fhir/ips
- Test data loaded (15 sample IPS documents)
```

#### 7. Your Verification
You test it and comment:
```
✅ Verified! I can see IPS 3.0.0 StructureDefinitions and the test
data is working correctly. Looks good!
```

#### 8. Completion
Label changes to `status:complete`

You receive Zulip notification.

Team asks if you're ready to promote to production or if you want to close the issue.

---

## Summary

**Remember**: You don't need to be technical to request changes! Just:
1. Pick the right template
2. Fill in what you know
3. Explain why you need it
4. Describe how to test it

The technical team will handle the rest and keep you updated.

**Questions?** Ask in Zulip or comment on any issue!
