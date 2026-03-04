# Scripts

This directory contains scripts for managing SmileCDR nodes.

## Test Data Management

Test data loading and clearing is now handled by the [`sparked-test-data-loader`](https://github.com/aehrc/sparked-test-data-loader) Go tool. The Python scripts (`load_test_data.py`, `clear_test_data.py`) are deprecated and kept for reference only.

### Using the Go Tool Locally

Install or run via Docker:

```bash
# Pull the Docker image
docker pull 471112546300.dkr.ecr.ap-southeast-2.amazonaws.com/sparked-test-data-loader:latest

# Or alias for convenience
alias fhir-data='docker run --rm -v "$(pwd):/data" 471112546300.dkr.ecr.ap-southeast-2.amazonaws.com/sparked-test-data-loader:latest'
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

**Clear and reload eRequesting test data:**
```bash
sparked-test-data-loader clear \
  --mode wipe-all \
  --fhir-url https://smile.sparked-fhir.com/ereq/fhir/DEFAULT \
  --auth-header "$FHIR_AUTH_HEADER" \
  --expunge

sparked-test-data-loader load \
  --method direct \
  --fhir-url https://smile.sparked-fhir.com/ereq/fhir/DEFAULT \
  --data-dir /tmp/test-data/au-fhir-test-data-set \
  --auth-header "$FHIR_AUTH_HEADER"
```

**Load to both AU Core + eRequesting nodes:**
```bash
# Load to aucore
sparked-test-data-loader load \
  --method direct \
  --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \
  --data-dir /tmp/test-data/au-fhir-test-data-set \
  --auth-header "$FHIR_AUTH_HEADER"

# Load to ereq
sparked-test-data-loader load \
  --method direct \
  --fhir-url https://smile.sparked-fhir.com/ereq/fhir/DEFAULT \
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
- Operations: `clear-and-load-aucore`, `clear-and-load-ereq`, `clear-and-load-aucore-and-ereq`, `clear-and-expunge`

Or use the individual workflows directly:
- **Load Test Data** (`load-test-data.yml`) - Load data to any node
- **Clear Test Data** (`clear-test-data.yml`) - Clear data from any node

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
python sync_packages.py --nodes aucore,hl7au --source config

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

The [manual-ig-load.yml](../.github/workflows/manual-ig-load.yml) workflow uses this script.

Simply:
1. Go to **Actions** → **Manual Package Management for SmileCDR Nodes**
2. Click **Run workflow**
3. Configure parameters and run

The workflow passes all inputs to this script, keeping the logic centralized.

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

- [Package Management Workflow Documentation](../docs/package-management-workflow.md)
- [SmileCDR Documentation](https://smilecdr.com/docs/)
