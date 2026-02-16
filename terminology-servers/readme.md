# Terminology Server Content Management

This directory manages the content loaded on the Sparked terminology servers via [atomio-ig-feeder](https://github.com/aehrc/atomio-ig-feeder/). The ig-feeder automatically syncs FHIR IG packages from the [HL7 AU package feed](https://hl7.org.au/fhir/package-feed.xml) to [Atomio](https://ontoserver.csiro.au/atomio/) syndication feeds based on the configuration in the helm values files.

## Servers

| Server | Helm Values File | Atomio URL | Feed Name | Purpose |
|--------|-----------------|------------|-----------|---------|
| **tx.dev** | `tx-dev-helm-values.yaml` | `synd.ontoserver.csiro.au` | `hl7au-dev` | Development/testing. Syncs **latest** version of ballot, preview, draft, and trial-use packages. |
| **tx.hl7** | `tx-hl7-helm-values.yaml` | `synd.tx.hl7.org.au` | `reference` | HL7 AU Reference. Syncs **all** versions of trial-use packages only. |

### Key differences

- **tx.dev** tracks pre-release content (`ballot`, `preview`, `draft`) and only keeps the latest version — useful for testing upcoming IGs.
- **tx.hl7** only tracks stable releases (`trial-use`) but keeps all versions — serves as the canonical reference server.

## How to request a content change

### Option 1: GitHub Issue (recommended)

Create a [TX Content Change issue](../../issues/new?template=04-tx-content-change.yml) using the form. The automation will:

1. Validate your request and post a dry-run preview
2. After admin approval, generate a PR modifying the helm values
3. After merge, the ig-feeder picks up the change on the next sync cycle

### Option 2: Script (for admins)

Use `scripts/update_tx_helm_values.py` to modify the helm values directly.

**Prerequisites:**

```bash
pip install -r scripts/requirements.txt
```

### Script usage

```
python scripts/update_tx_helm_values.py \
    --action {add-watch,remove-watch,modify-watch} \
    --server {tx-dev,tx-hl7}  \
    --package-id PACKAGE_ID \
    [--package-list-url URL] \
    [--display-name NAME] \
    [--statuses STATUS[,STATUS...]] \
    [--version-mode {latest,all,pinned}] \
    [--versions VERSION[,VERSION...]] \
    [--feed-name FEED] \
    [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--action` | Yes | `add-watch`, `remove-watch`, or `modify-watch` |
| `--server` | Yes | Comma-separated: `tx-dev`, `tx-hl7`, or both |
| `--package-id` | Yes | FHIR package ID (e.g. `hl7.fhir.au.ereq`) |
| `--package-list-url` | For add | URL to the IG's `package-list.json` |
| `--display-name` | No | Display name (e.g. `AU eRequesting`). Auto-derived if omitted. |
| `--statuses` | For add | Comma-separated: `trial-use`, `ballot`, `preview`, `draft` |
| `--version-mode` | No | `latest` (default), `all`, or `pinned` |
| `--versions` | For pinned | Comma-separated version list (e.g. `6.0.0,5.0.0`) |
| `--feed-name` | No | Override the default feed (tx-dev: `hl7au-dev`, tx-hl7: `reference`) |
| `--dry-run` | No | Preview changes without writing files |

### Option 3: Edit the YAML directly

Edit `tx-dev-helm-values.yaml` or `tx-hl7-helm-values.yaml` and add/remove/modify entries in the `feeds[].watches[]` array. See [Watch configuration](#watch-configuration) below for the schema.

## Common examples

### Add a new IG to both servers

> "Please upload eRequesting 1.0.0 to both terminology servers"

The two servers have different content strategies, so you typically want different settings for each:

**tx.dev** — track all pre-release and release versions, keep only latest:

```bash
python scripts/update_tx_helm_values.py \
    --action add-watch \
    --server tx-dev \
    --package-id hl7.fhir.au.ereq \
    --package-list-url https://hl7.org.au/fhir/ereq/package-list.json \
    --display-name "AU eRequesting" \
    --statuses "ballot,preview,draft,trial-use" \
    --version-mode latest \
    --dry-run
```

**tx.hl7** — track only stable releases, keep all versions:

```bash
python scripts/update_tx_helm_values.py \
    --action add-watch \
    --server tx-hl7 \
    --package-id hl7.fhir.au.ereq \
    --package-list-url https://hl7.org.au/fhir/ereq/package-list.json \
    --display-name "AU eRequesting" \
    --statuses "trial-use" \
    --version-mode all \
    --dry-run
```

Or if you want identical settings on both (e.g. just pin a specific version):

```bash
python scripts/update_tx_helm_values.py \
    --action add-watch \
    --server tx-dev,tx-hl7 \
    --package-id hl7.fhir.au.ereq \
    --package-list-url https://hl7.org.au/fhir/ereq/package-list.json \
    --display-name "AU eRequesting" \
    --statuses "trial-use" \
    --version-mode pinned \
    --versions "1.0.0" \
    --dry-run
```

### Remove a package from a server

```bash
python scripts/update_tx_helm_values.py \
    --action remove-watch \
    --server tx-dev \
    --package-id hl7.fhir.au.ereq \
    --dry-run
```

### Change version mode (e.g. pin to specific versions)

```bash
python scripts/update_tx_helm_values.py \
    --action modify-watch \
    --server tx-hl7 \
    --package-id hl7.fhir.au.base \
    --version-mode pinned \
    --versions "6.0.0,5.0.0" \
    --dry-run
```

### Change which statuses are tracked

```bash
python scripts/update_tx_helm_values.py \
    --action modify-watch \
    --server tx-dev \
    --package-id hl7.fhir.au.core \
    --statuses "trial-use" \
    --dry-run
```

## Finding the package-list-url

When adding a new watch, you need the URL to the IG's `package-list.json`. Common patterns:

| IG | Package ID | Package List URL |
|----|-----------|------------------|
| AU Base | `hl7.fhir.au.base` | `https://hl7.org.au/fhir/package-list.json` |
| AU Core | `hl7.fhir.au.core` | `https://hl7.org.au/fhir/core/package-list.json` |
| AU eRequesting | `hl7.fhir.au.ereq` | `https://hl7.org.au/fhir/ereq/package-list.json` |
| AU Patient Summary | `hl7.fhir.au.ps` | `https://hl7.org.au/fhir/ps/package-list.json` |

You can also find the package list URL on the IG's Simplifier page or in the IG's published specification under the "Downloads" page.

## Watch configuration

Each watch in the helm values follows this schema:

```yaml
watches:
  - packageId: hl7.fhir.au.base           # FHIR package ID (required)
    packageListUrl: https://...            # URL to package-list.json (required)
    displayName: AU Base                   # Display name (optional, auto-derived)
    statuses: [trial-use]                  # Release statuses to sync (required)
    versionMode: all                       # latest | all | pinned (default: latest)
    versions: ["6.0.0", "5.0.0"]           # Only for pinned mode
```

### Version modes

| Mode | Behaviour | Use case |
|------|-----------|----------|
| `latest` | Only the newest version matching the status filter | tx.dev default - always have the latest |
| `all` | Every version matching the status filter | tx.hl7 default - maintain version history |
| `pinned` | Only explicitly listed versions | Lock to specific versions for testing |

### Status values

| Status | Description |
|--------|-------------|
| `trial-use` | Stable release (published) |
| `ballot` | Ballot version (for review/comment) |
| `preview` | Preview release |
| `draft` | Draft/development version |

## Full ig-feeder documentation

For the full atomio-ig-feeder documentation including the REST API, web UI, Keycloak setup, Helm deployment options, and data flow, see the upstream project: https://github.com/aehrc/atomio-ig-feeder/
