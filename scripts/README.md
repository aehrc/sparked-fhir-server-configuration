# Scripts

This directory contains scripts for managing SmileCDR nodes.

## Test Data Management

Test data loading and clearing is now handled by the `sparked-test-data-loader` Go tool (`aehrc/sparked-test-data-loader`, an internal repository). The Python scripts (`load_test_data.py`, `clear_test_data.py`) are deprecated and kept for reference only.

### Using the Go Tool Locally

Install or run via Docker:

```bash
# Pull the Docker image
docker pull <AWS_ACCOUNT_ID>.dkr.ecr.ap-southeast-2.amazonaws.com/sparked-test-data-loader:latest

# Or alias for convenience
alias fhir-data='docker run --rm -v "$(pwd):/data" <AWS_ACCOUNT_ID>.dkr.ecr.ap-southeast-2.amazonaws.com/sparked-test-data-loader:latest'
```

### Common Use Cases

**Clear all test data + expunge from a node:**
```bash
sparked-test-data-loader clear \
  --mode wipe-all \
  --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \
  --auth-header "$FHIR_AUTH_HEADER" \
  --expunge
```

**Clear and reload AU Core test data:**
```bash
# Clone test data
git clone https://github.com/hl7au/au-fhir-test-data /tmp/test-data

# Clear existing data
sparked-test-data-loader clear \
  --mode wipe-all \
  --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \
  --auth-header "$FHIR_AUTH_HEADER" \
  --expunge

# Load fresh data
sparked-test-data-loader load \
  --method direct \
  --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \
  --data-dir /tmp/test-data/au-fhir-test-data-set \
  --auth-header "$FHIR_AUTH_HEADER"
```

**Dry run (preview without changes):**
```bash
sparked-test-data-loader load \
  --method direct \
  --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \
  --data-dir /tmp/test-data/au-fhir-test-data-set \
  --auth-header "$FHIR_AUTH_HEADER" \
  --dry-run
```

### GitHub Actions Workflows

Use the **Manage Test Data** workflow for common operations:
- **Actions** -> **Manage Test Data** -> **Run workflow**
- Operations: `clear-and-load-aucore`, `clear-and-expunge`

Or use the individual workflows directly:
- **Load Test Data** (`load-test-data.yml`) - Load data to any node
- **Clear Test Data** (`clear-test-data.yml`) - Clear data from any node

---

## SMART Client Registration

Register SMART on FHIR / OIDC clients on the aucore node.

The script calls the admin JSON API at `https://smile.sparked-fhir.com/aucore/admin-json`, which is IP-restricted (use it from the CSIRO network or VPN). `SMILECDR_ADMIN_URL` (or `--admin-url`) points it elsewhere, with every `{node}` replaced by `--node`: the registration workflows set it to the in-cluster Service `http://smilecdr-scdrnode-{node}-admin-json.smile.svc.cluster.local:9000/{node}/admin-json`, reachable only from the `arc-runner-smile-admin` runners (a scale set reserved for the registration jobs, in a runner group that serves this repository only). The script refuses an admin URL whose path is not `/<node>/admin-json`, and checks that the address answers (one retry) before it registers anything.

```bash
export CSIRO_FHIR_AUTH_64="your_base64_credentials"

# Register a SMART App Launch client
python scripts/register_smart_client.py \
  --client-type smart-app-launch \
  --client-id my-app \
  --client-name "My SMART App" \
  --redirect-uris "http://localhost:3000/callback" \
  --scopes "launch/patient patient/*.read openid fhirUser offline_access"

# Register a Backend Service client
python scripts/register_smart_client.py \
  --client-type backend-service \
  --client-id my-backend \
  --client-name "My Backend Service" \
  --scopes "system/*.*"

# Bulk register connectathon clients
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json

# Update existing clients with permissions
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json \
  --update-existing

# Dry run (preview only)
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json --dry-run
```

## SMART User Management

Create user accounts for SMART App Launch authorization flows.

```bash
export CSIRO_FHIR_AUTH_64="your_base64_credentials"

# Create a single user (password auto-generated)
python scripts/manage_smart_users.py \
  --username test-user \
  --given-name Test \
  --family-name User \
  --permissions read-only \
  --practitioner-id guthrie-aaron

# Bulk create connectathon users
python scripts/manage_smart_users.py \
  --bulk --users-file module-config/connectathon-users.json

# Dry run
python scripts/manage_smart_users.py \
  --bulk --users-file module-config/connectathon-users.json --dry-run
```

Permission presets: `read-only`, `read-write`, `superuser`.

See [SMART App Registration Guide](../docs/SMART-APP-REGISTRATION.md) for the full admin operations cheat sheet.

---

## SMART Auth Config Reconciliation

`sync_smart_auth.py` diffs the canonical `smart_auth` config (including
`module-config/smart-post-authorize.js`) against the live Admin JSON API and
can apply the differences. The node runs `PROPERTIES_UNLOCKED`
(`module-config/values-sparkey.yaml`): module config is re-read from the
Helm-rendered ConfigMap on every boot, so anything this script applies is lost
on the next pod restart. Use it to show drift or to try a change live; make the
lasting change in `module-config/` in a PR; merging it is the deploy (Argo CD syncs
the `smilecdr` Application). See
[SMART Auth Configuration](../docs/smart-auth-config.md) for the drift model.

```bash
export CSIRO_FHIR_AUTH_64="your_base64_credentials"

# Show drift on all supported nodes (dry-run is the default)
python scripts/sync_smart_auth.py

# Apply to all supported nodes (restarts the smart_auth module)
python scripts/sync_smart_auth.py --apply

# Single node
python scripts/sync_smart_auth.py --apply --node aucore

# Also archive the unused appSphere (app_gallery) module
python scripts/sync_smart_auth.py --archive-app-gallery --apply
```

Applying restarts `smart_auth` on the target node, briefly interrupting token
issuance and OAuth logins there. Run it outside connectathon hours.

The DEFAULT read-only consent service (`module-config/consent-default-readonly.js`)
has been enforcing on `aucore` since 2026-08-19, so participant writes to
`DEFAULT` are refused at request time. `register_smart_client.py` also refuses
to register a write-capable backend client against `DEFAULT` unless
`--allow-default-write` is passed for a curator client.

---

## Package Synchronization

### Files

- **sync_packages.py** - Main package synchronization script
- **requirements.txt** - Python dependencies

## Quick Start

### Install Dependencies

```bash
pip install -r requirements.txt
```

### Set Environment Variables

```bash
export SMILECDR_BASE_URL="https://smile.sparked-fhir.com"
export SMILECDR_AUTH_BASIC="your_base64_encoded_credentials"
```

### Run Examples

```bash
# Dry run for all nodes (preview changes)
python sync_packages.py --nodes all --source config --dry-run

# Apply changes to aucore node
python sync_packages.py --nodes aucore --source config

# Update multiple specific nodes
python sync_packages.py --nodes aucore --source config

# Force reinstall all packages
python sync_packages.py --nodes all --source config --force-reinstall

# Install custom package
python sync_packages.py \
  --nodes aucore \
  --source custom \
  --packages '[{"name":"hl7.fhir.au.base","version":"6.0.0-ballot","installMode":"STORE_ONLY","fetchDependencies":true}]'
```

### Command-Line Options

```
usage: sync_packages.py [-h] [--base-url BASE_URL] [--auth AUTH] --nodes NODES
                        [--source {config,packages-dir,custom}]
                        [--packages PACKAGES] [--config-dir CONFIG_DIR]
                        [--dry-run] [--force-reinstall]

optional arguments:
  -h, --help            show this help message and exit
  --base-url BASE_URL   SmileCDR base URL (default: from SMILECDR_BASE_URL env var)
  --auth AUTH           Base64 encoded basic auth credentials (default: from SMILECDR_AUTH_BASIC env var)
  --nodes NODES         Comma-separated list of node names or "all" for all enabled nodes
  --source {config,packages-dir,custom}
                        Package source: config, packages-dir, or custom (default: config)
  --packages PACKAGES   Custom packages JSON (required if source=custom)
  --config-dir CONFIG_DIR
                        Path to module-config directory (default: module-config)
  --dry-run             Show what would be done without making changes
  --force-reinstall     Force reinstall all packages even if already installed
```

## How It Works

1. **Determine nodes** - From input or auto-detect from `simplified-multinode.yaml`
2. **Load packages** - From config, packages directory, or custom JSON
3. **Fetch current state** - Query each node for installed packages
4. **Compare and sync** - Install/update packages as needed
5. **Report results** - Show summary of all operations

## Integration with GitHub Actions

The [reload-ig-config.yml](../.github/workflows/reload-ig-config.yml) workflow and the IG release dry run in [issue-opened.yml](../.github/workflows/issue-opened.yml) call this script.

## Testing Locally

Before running the GitHub Actions workflow, you can test locally:

```bash
# 1. Clone the repo
cd sparked-fhir-server-configuration

# 2. Install dependencies
pip install -r scripts/requirements.txt

# 3. Set credentials (get from AWS Secrets Manager or your team)
export SMILECDR_AUTH_BASIC="..."

# 4. Run dry-run
python scripts/sync_packages.py --nodes aucore --source config --dry-run

# 5. Review output, then apply if looks good
python scripts/sync_packages.py --nodes aucore --source config
```

## Troubleshooting

### Import Errors

```bash
# Make sure dependencies are installed
pip install -r requirements.txt
```

### Authentication Errors

```bash
# Verify your credentials work
export SMILECDR_AUTH_BASIC="your_credentials"
curl -H "Authorization: Basic $SMILECDR_AUTH_BASIC" \
  https://smile.sparked-fhir.com/aucore/package/npm/-/v1/search
```

### Config File Not Found

```bash
# Make sure you're in the repo root
cd /path/to/sparked-fhir-server-configuration

# Or specify config directory explicitly
python scripts/sync_packages.py \
  --config-dir /path/to/module-config \
  --nodes aucore \
  --source config
```

## See Also

- [Workflows](../docs/WORKFLOWS.md)
- [SmileCDR Documentation](https://smilecdr.com/docs/)
