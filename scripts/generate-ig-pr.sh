#!/bin/bash
# Helper script to generate IG release PR from a GitHub issue
# Usage: ./generate-ig-pr.sh <issue-number>

set -e

ISSUE_NUMBER=$1

if [ -z "$ISSUE_NUMBER" ]; then
    echo "Usage: $0 <issue-number>"
    echo ""
    echo "Example: $0 42"
    exit 1
fi

echo "📋 Fetching issue #$ISSUE_NUMBER..."

# Fetch issue details using gh CLI
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) is required but not installed."
    echo "Install from: https://cli.github.com/"
    exit 1
fi

ISSUE_BODY=$(gh issue view $ISSUE_NUMBER --json body -q .body)

# Parse issue body to extract fields
extract_field() {
    local label="$1"
    echo "$ISSUE_BODY" | perl -0777 -ne "print \$1 if /### $label\s*(.*?)(?=###|\$)/is" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

IG_NAME=$(extract_field "Implementation Guide Name")
IG_VERSION=$(extract_field "IG Version")
PACKAGE_ID=$(extract_field "NPM Package ID")
REQUEST_TYPE=$(extract_field "Request Type")

echo ""
echo "📦 Extracted Information:"
echo "  IG Name: $IG_NAME"
echo "  Version: $IG_VERSION"
echo "  Package ID: ${PACKAGE_ID:-'<not provided>'}"
echo "  Type: $REQUEST_TYPE"
echo ""

# Validate required fields
if [ -z "$IG_NAME" ] || [ -z "$IG_VERSION" ]; then
    echo "❌ Missing required fields: IG Name or Version"
    exit 1
fi

# Generate safe filenames
SAFE_NAME=$(echo "$IG_NAME" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-' | sed 's/[^a-z0-9-]//g')
BRANCH_NAME="ig-release/issue-${ISSUE_NUMBER}-${SAFE_NAME}-${IG_VERSION}"
PACKAGE_FILE_NAME="package-${SAFE_NAME}-${IG_VERSION}.json"

echo "🔧 Generated Names:"
echo "  Branch: $BRANCH_NAME"
echo "  Package File: $PACKAGE_FILE_NAME"
echo ""

# Prompt for package ID if not provided
if [ -z "$PACKAGE_ID" ]; then
    echo "⚠️  No NPM Package ID provided in issue."
    read -p "Enter NPM Package ID (e.g., hl7.fhir.uv.ips): " PACKAGE_ID
    if [ -z "$PACKAGE_ID" ]; then
        echo "❌ Package ID is required"
        exit 1
    fi
fi

# Prompt for package installation options
echo ""
echo "📦 Package Installation Options:"
read -p "Install package automatically? (STORE_AND_INSTALL) [y/N]: " INSTALL_CHOICE
if [[ $INSTALL_CHOICE =~ ^[Yy]$ ]]; then
    INSTALL_MODE="STORE_AND_INSTALL"
else
    INSTALL_MODE="STORE"
fi

read -p "Fetch dependencies automatically? [y/N]: " FETCH_DEPS_CHOICE
if [[ $FETCH_DEPS_CHOICE =~ ^[Yy]$ ]]; then
    FETCH_DEPS="true"
else
    FETCH_DEPS="false"
fi

echo ""
echo "Package Configuration:"
echo "  installMode: $INSTALL_MODE"
echo "  fetchDependencies: $FETCH_DEPS"

echo ""
read -p "Continue with PR generation? (y/N): " CONFIRM
if [[ ! $CONFIRM =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# Create branch
echo ""
echo "🌿 Creating branch: $BRANCH_NAME"
git checkout -b "$BRANCH_NAME"

# Create package JSON file
echo ""
echo "📄 Creating package file..."
PACKAGE_FILE="module-config/packages/$PACKAGE_FILE_NAME"

cat > "$PACKAGE_FILE" <<EOF
{
  "name": "$PACKAGE_ID",
  "version": "$IG_VERSION",
  "installMode": "$INSTALL_MODE",
  "fetchDependencies": $FETCH_DEPS
}
EOF

echo "✅ Created: $PACKAGE_FILE"
cat "$PACKAGE_FILE"

# Validate JSON
if ! jq empty "$PACKAGE_FILE" 2>/dev/null; then
    echo "❌ Invalid JSON generated"
    exit 1
fi

# Update values-common.yaml mappedFiles section
echo ""
echo "📝 Updating values-common.yaml mappedFiles..."

python3 <<'PYTHON_SCRIPT'
import os
import re

package_file_name = os.environ['PACKAGE_FILE_NAME']
values_file = 'module-config/values-common.yaml'

# Read the file as text to preserve formatting and comments
with open(values_file, 'r') as f:
    content = f.read()

# Check if the package already exists
if f"  {package_file_name}:" in content:
    print(f"ℹ️  {package_file_name} already exists in mappedFiles")
else:
    # Find the last entry in mappedFiles and add after it
    # Look for the last "    path: /home/smile/smilecdr/classes/config_seeding" line under mappedFiles
    lines = content.split('\n')
    new_lines = []
    inserted = False
    in_mapped_files = False
    last_mapped_file_index = -1

    for i, line in enumerate(lines):
        if line.startswith('mappedFiles:'):
            in_mapped_files = True
        elif in_mapped_files and line and not line.startswith(' '):
            # We've reached the next section
            in_mapped_files = False
        elif in_mapped_files and '    path: /home/smile/smilecdr/classes/config_seeding' in line:
            last_mapped_file_index = i

    if last_mapped_file_index >= 0:
        # Insert after the last mappedFiles entry
        for i, line in enumerate(lines):
            new_lines.append(line)
            if i == last_mapped_file_index:
                new_lines.append(f"  {package_file_name}:")
                new_lines.append("    path: /home/smile/smilecdr/classes/config_seeding")
                inserted = True

        if inserted:
            content = '\n'.join(new_lines)
            print(f"✅ Added {package_file_name} to mappedFiles")
        else:
            print("⚠️  Could not find insertion point")
    else:
        print("⚠️  Could not find mappedFiles section")

    # Write back to file
    with open(values_file, 'w') as f:
        f.write(content)

print("✅ Updated values-common.yaml")
PYTHON_SCRIPT
export PACKAGE_FILE_NAME="$PACKAGE_FILE_NAME"

# Check if package already exists in terraform/main.tf
echo ""
echo "🔍 Checking terraform/main.tf..."

if grep -q "module-config/packages/$PACKAGE_FILE_NAME" terraform/main.tf; then
    echo "ℹ️  Package already referenced in terraform/main.tf (update scenario)"
else
    echo "📝 Adding package reference to terraform/main.tf..."

    # Find the line with "# Users configuration" and insert before it
    # This is a safe insertion point
    TEMP_FILE=$(mktemp)

    awk -v pkg="$PACKAGE_FILE_NAME" '
    /# Users configuration/ {
        print "    {"
        print "      name     = \"" pkg "\""
        print "      location = \"classes/config_seeding\""
        print "      data     = file(\"../module-config/packages/" pkg "\")"
        print "    },"
        print ""
    }
    { print }
    ' terraform/main.tf > "$TEMP_FILE"

    mv "$TEMP_FILE" terraform/main.tf
    echo "✅ Updated terraform/main.tf"
fi

# Validate terraform format
echo ""
echo "🔧 Formatting Terraform..."
terraform fmt terraform/main.tf

# Commit changes
echo ""
echo "💾 Committing changes..."

git add "$PACKAGE_FILE"
git add module-config/values-common.yaml
git add terraform/main.tf

git commit -m "Add $IG_NAME $IG_VERSION

Auto-generated from issue #$ISSUE_NUMBER

Changes:
- Created $PACKAGE_FILE
- Updated values-common.yaml mappedFiles section
- Updated terraform/main.tf to reference new package

Implements: #$ISSUE_NUMBER"

# Push branch
echo ""
echo "🚀 Pushing branch..."
git push origin "$BRANCH_NAME"

# Create PR
echo ""
echo "📬 Creating Pull Request..."

PR_BODY=$(cat <<EOF
## Auto-generated IG Release PR

This PR was generated from issue #$ISSUE_NUMBER.

### Implementation Guide Details
- **IG Name**: $IG_NAME
- **Version**: $IG_VERSION
- **Package ID**: $PACKAGE_ID
- **Request Type**: $REQUEST_TYPE

### Changes Made
- ✅ Created \`$PACKAGE_FILE\`
- ✅ Updated \`values-common.yaml\` mappedFiles section
- ✅ Updated \`terraform/main.tf\` to reference new package

### Next Steps
1. **Review** the generated files
2. **Verify** package ID is correct
3. **Check** if \`simplified-multinode.yaml\` needs updates
4. **Approve** this PR
5. **Merge** to trigger deployment
6. **Verify** deployment in target environment
7. **Update** issue #$ISSUE_NUMBER when verified

### ⚠️  Manual Review Required
- [ ] Package ID is correct
- [ ] Version is correct
- [ ] simplified-multinode.yaml updated if needed
- [ ] Test data requirements addressed
- [ ] Terraform plan looks good

### Rollback Plan
If issues occur after merge:
1. Revert this PR
2. Run \`cd terraform && terraform apply\`
3. Update issue #$ISSUE_NUMBER

---
Closes #$ISSUE_NUMBER

🤖 This PR was generated using the helper script
EOF
)

PR_URL=$(gh pr create \
    --title "Add $IG_NAME $IG_VERSION (Issue #$ISSUE_NUMBER)" \
    --body "$PR_BODY" \
    --base main \
    --head "$BRANCH_NAME")

echo ""
echo "✅ Pull Request created: $PR_URL"

# Comment on issue
echo ""
echo "💬 Commenting on issue..."

gh issue comment $ISSUE_NUMBER --body "🤖 **PR Created!**

Pull Request has been created: $PR_URL

### What was generated:
- ✅ Package file: \`$PACKAGE_FILE\`
- ✅ Updated: \`values-common.yaml\` mappedFiles section
- ✅ Updated: \`terraform/main.tf\`

### Next Steps:
1. Review the PR for accuracy
2. Approve and merge when ready
3. Deployment will happen automatically
4. You'll be tagged for verification

If anything needs adjustment, please comment on the PR!"

# Update labels
echo ""
echo "🏷️  Updating issue labels..."
gh issue edit $ISSUE_NUMBER --add-label "auto-pr-created,status:in-progress" --remove-label "ready-for-automation" || true

echo ""
echo "🎉 Done!"
echo ""
echo "Summary:"
echo "  Issue: #$ISSUE_NUMBER"
echo "  Branch: $BRANCH_NAME"
echo "  PR: $PR_URL"
echo ""
echo "Next: Review and merge the PR to deploy the IG!"
