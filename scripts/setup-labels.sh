#!/bin/bash
# Script to create GitHub labels for issue tracking
# Requires GitHub CLI (gh) to be installed and authenticated

set -e

echo "Creating GitHub labels for sparked-fhir-server-configuration..."

# Request Types
gh label create "ig-release" --color "0366d6" --description "Implementation Guide release request" --force
gh label create "configuration" --color "1d76db" --description "Configuration change request" --force
gh label create "operations" --color "5319e7" --description "Operational request (data load, expunge, etc.)" --force
gh label create "tx-content" --color "006b75" --description "Terminology server content change request" --force

# Status Labels (flow: needs-review → approved → in-progress → deployed → complete)
gh label create "needs-review" --color "fbca04" --description "Awaiting technical review" --force
gh label create "approved" --color "0e8a16" --description "Request approved, ready to implement" --force
gh label create "in-progress" --color "0075ca" --description "Work in progress" --force
gh label create "deployed" --color "28a745" --description "Changes deployed, awaiting verification" --force
gh label create "complete" --color "28a745" --description "Completed and verified" --force
gh label create "blocked" --color "d93f0b" --description "Blocked by external dependency" --force

# Priority Labels
gh label create "priority:critical" --color "b60205" --description "Critical - Blocking work" --force
gh label create "priority:high" --color "d93f0b" --description "High - Needed within 1 week" --force
gh label create "priority:medium" --color "fbca04" --description "Medium - Needed within 2 weeks" --force
gh label create "priority:low" --color "c5def5" --description "Low - Can wait for next scheduled release" --force

# General Labels
gh label create "automation" --color "bfdadc" --description "Request to automate an operation" --force
gh label create "documentation" --color "0075ca" --description "Documentation improvements or requests" --force
gh label create "question" --color "cc317c" --description "Question or help request" --force
gh label create "duplicate" --color "cfd3d7" --description "Duplicate of another issue" --force
gh label create "wontfix" --color "ffffff" --description "Will not be implemented" --force

# Automation Labels
gh label create "ready-for-automation" --color "0e8a16" --description "Issue has all info needed for automated PR generation" --force
gh label create "auto-pr-created" --color "1d76db" --description "Automated PR has been created for this issue" --force
gh label create "needs-manual-intervention" --color "d93f0b" --description "Automation failed, requires manual implementation" --force
gh label create "deploy-immediately" --color "d93f0b" --description "Request immediate deployment after PR merge" --force

echo "All labels created successfully!"
echo ""
echo "View your labels at: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/labels"
