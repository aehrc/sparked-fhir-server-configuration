#!/usr/bin/env python3
"""
SMART Auth Module Config Reconciliation

Node module config is database-backed (config.database: true in
module-config/simplified-multinode.yaml), so console edits are authoritative
at runtime and the Helm values only seed a first boot. This script makes the
repo the source of truth again: it diffs the canonical smart_auth
configuration (including module-config/smart-post-authorize.js) against the
live Admin JSON API and applies the differences.

Canonical configuration per node:
    post_authorize_script.text   rendered from module-config/smart-post-authorize.js
                                 with the DEFAULT_AUDIENCE_BASE node segment
                                 rewritten to the target node
    post_authorize_script.file   cleared (the DB-stored text is authoritative;
                                 the classpath file only serves first-boot seeding)
    auth_request_detail.whitelist aud,grant_type,scope,launch
    openid.signing.keystore_id   smilecdr-token-signing
    cors.enable                  true
    smart_capabilities_list      SMART capability advertisement, including
                                 context-ehr-encounter (the launch script
                                 injects encounter context)

hl7au is deliberately excluded: its live smart_auth predates the per-node
layout (bare /smartauth context path, default-keystore). See
docs/smart-auth-config.md.

API Reference:
    https://smilecdr.com/docs/json_admin_endpoints/module_config_endpoint.html
    GET    /module-config/{nodeId}/{moduleId}          - Fetch module config
    PUT    /module-config/{nodeId}/{moduleId}/set      - Update config (?restart=true)
    POST   /module-config/{nodeId}/{moduleId}/stop     - Stop module
    DELETE /module-config/{nodeId}/{moduleId}/archive  - Archive module

Usage:
    # Show drift without changing anything (default)
    python sync_smart_auth.py

    # Apply the canonical config to all supported nodes (restarts smart_auth)
    python sync_smart_auth.py --apply

    # Single node
    python sync_smart_auth.py --apply --node ereq

    # Archive the unused appSphere module (see docs/smart-auth-config.md)
    python sync_smart_auth.py --archive-app-gallery --apply

Environment Variables:
    CSIRO_FHIR_AUTH_64: Base64 encoded basic auth credentials (admin account).
        Build from AWS Secrets Manager with:
        export CSIRO_FHIR_AUTH_64=$(printf 'ADMIN:%s' "$(aws secretsmanager \\
            get-secret-value --secret-id smilecdr-user-passwords \\
            --query SecretString --output text | jq -r \\
            '."smilecdr-admin-password"')" | base64)
    SMILECDR_BASE_URL: Base URL (default: https://smile.sparked-fhir.com)

Note: applying restarts the smart_auth module on the target node, which
briefly interrupts token issuance and OAuth logins on that node.
"""

import argparse
import difflib
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    print("Error: 'requests' library is required. Install with: pip install requests")
    sys.exit(1)


# =============================================================================
# Constants
# =============================================================================

DEFAULT_BASE_URL = "https://smile.sparked-fhir.com"
MODULE_ID = "smart_auth"
APP_GALLERY_MODULE_ID = "app_gallery"
SUPPORTED_NODES = ["aucore", "ereq"]

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "module-config" / "smart-post-authorize.js"

# The node segment in this URL is rewritten per node when rendering the script.
AUCORE_AUDIENCE_BASE = f"{DEFAULT_BASE_URL}/aucore/fhir/DEFAULT"

AUTH_REQUEST_WHITELIST = "aud,grant_type,scope,launch"
SIGNING_KEYSTORE_ID = "smilecdr-token-signing"

# SMART capability advertisement (.well-known/smart-configuration).
# context-ehr-encounter is included because smart-post-authorize.js injects
# encounter launch context. Multi-line, so managed here rather than in the
# Helm values (properties rendering of multi-line values is unsafe).
SMART_CAPABILITIES = [
    "launch-ehr",
    "launch-standalone",
    "client-public",
    "client-confidential-symmetric",
    "context-ehr-patient",
    "context-ehr-encounter",
    "context-standalone-patient",
    "sso-openid-connect",
    "permission-patient",
    "permission-offline",
]


def render_post_authorize_script(node: str) -> str:
    """Render smart-post-authorize.js for a node.

    Rewrites the DEFAULT_AUDIENCE_BASE node segment so standalone launches
    with no resolvable audience mint fhirUser URLs against the node's own
    FHIR base rather than aucore's.
    """
    text = SCRIPT_PATH.read_text(encoding="utf-8")
    if AUCORE_AUDIENCE_BASE not in text:
        print(f"FATAL: expected audience base '{AUCORE_AUDIENCE_BASE}' not found in {SCRIPT_PATH}")
        sys.exit(1)
    node_base = f"{DEFAULT_BASE_URL}/{node}/fhir/DEFAULT"
    return text.replace(AUCORE_AUDIENCE_BASE, node_base)


def desired_options(node: str) -> Dict[str, str]:
    """Canonical smart_auth option values for a node.

    Keys not listed here are left exactly as they are on the server.
    """
    return {
        "post_authorize_script.text": render_post_authorize_script(node),
        "post_authorize_script.file": "",
        "auth_request_detail.whitelist": AUTH_REQUEST_WHITELIST,
        "openid.signing.keystore_id": SIGNING_KEYSTORE_ID,
        "cors.enable": "true",
        "smart_capabilities_list": "\n".join(SMART_CAPABILITIES),
    }


# =============================================================================
# HTTP
# =============================================================================

def create_session(auth_header: str) -> requests.Session:
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Basic {auth_header}",
    })
    return session


class ModuleConfigClient:
    """Thin wrapper over the SmileCDR Admin JSON module-config endpoint."""

    def __init__(self, base_url: str, auth_header: str, node: str):
        self.node = node
        self.admin_url = f"{base_url.rstrip('/')}/{node}/admin-json"
        self.session = create_session(auth_header)

    def _module_url(self, module_id: str, suffix: str = "") -> str:
        return f"{self.admin_url}/module-config/{self.node}/{module_id}{suffix}"

    def get_module(self, module_id: str) -> Optional[Dict]:
        resp = self.session.get(self._module_url(module_id), timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    def set_module_options(self, module_id: str, options: List[Dict], restart: bool) -> None:
        """PUT the full options list back (fetch-modify-put, never a partial list)."""
        suffix = "/set?restart=true" if restart else "/set"
        resp = self.session.put(
            self._module_url(module_id, suffix),
            json={"options": options},
            timeout=60,
        )
        resp.raise_for_status()

    def stop_module(self, module_id: str) -> None:
        resp = self.session.post(self._module_url(module_id, "/stop"), timeout=60)
        resp.raise_for_status()

    def archive_module(self, module_id: str) -> None:
        resp = self.session.delete(self._module_url(module_id, "/archive"), timeout=60)
        resp.raise_for_status()


# =============================================================================
# Reconciliation
# =============================================================================

def summarize_change(key: str, live: str, desired: str) -> str:
    if "\n" in desired or "\n" in live:
        diff = list(difflib.unified_diff(
            live.splitlines(), desired.splitlines(), lineterm="", n=0,
        ))
        changed = len([l for l in diff if l[:1] in "+-" and l[:3] not in ("+++", "---")])
        return f"{key}: multi-line value differs ({changed} changed lines)"
    live_disp = live if live else "(empty)"
    desired_disp = desired if desired else "(empty)"
    return f"{key}: {live_disp!r} -> {desired_disp!r}"


def reconcile_node(client: ModuleConfigClient, node: str, apply: bool, restart: bool) -> bool:
    """Diff and optionally apply canonical smart_auth config. Returns True if in sync or applied."""
    print(f"\n=== {node}/{MODULE_ID} ===")
    module = client.get_module(MODULE_ID)
    if module is None:
        print(f"  [FAIL] module {MODULE_ID} not found on node {node}")
        return False

    options: List[Dict] = module.get("options", [])
    live = {opt["key"]: opt.get("value") or "" for opt in options}
    desired = desired_options(node)

    changes = {k: v for k, v in desired.items() if live.get(k, "") != v}
    if not changes:
        print("  In sync, nothing to do.")
        return True

    for key, value in changes.items():
        print("  " + summarize_change(key, live.get(key, ""), value))

    if not apply:
        print(f"  [DRY RUN] {len(changes)} option(s) would be updated. Re-run with --apply.")
        return True

    known_keys = {opt["key"] for opt in options}
    for opt in options:
        if opt["key"] in changes:
            opt["value"] = changes[opt["key"]]
    for key, value in changes.items():
        if key not in known_keys:
            options.append({"key": key, "value": value})

    client.set_module_options(MODULE_ID, options, restart=restart)
    restart_note = "module restarting" if restart else "restart deferred (--no-restart)"
    print(f"  [OK] {len(changes)} option(s) updated, {restart_note}.")
    return True


def archive_app_gallery(client: ModuleConfigClient, node: str, apply: bool) -> bool:
    """Stop and archive the appSphere module if present. Returns True on success/no-op."""
    print(f"\n=== {node}/{APP_GALLERY_MODULE_ID} ===")
    module = client.get_module(APP_GALLERY_MODULE_ID)
    if module is None:
        print("  Not present, nothing to do.")
        return True

    if not apply:
        print("  [DRY RUN] Would stop and archive this module. Re-run with --apply.")
        return True

    client.stop_module(APP_GALLERY_MODULE_ID)
    client.archive_module(APP_GALLERY_MODULE_ID)
    print("  [OK] Stopped and archived.")
    return True


# =============================================================================
# Main
# =============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconcile live smart_auth module config with the repo",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--node", choices=SUPPORTED_NODES, action="append",
                        help="Node(s) to reconcile (default: all supported nodes)")
    parser.add_argument("--apply", action="store_true",
                        help="Apply changes (default is a dry-run diff)")
    parser.add_argument("--no-restart", action="store_true",
                        help="Update config without restarting the module "
                             "(changes take effect on the next restart)")
    parser.add_argument("--archive-app-gallery", action="store_true",
                        help="Also stop and archive the unused appSphere (app_gallery) module")
    parser.add_argument("--base-url", default=os.environ.get("SMILECDR_BASE_URL", DEFAULT_BASE_URL),
                        help="Base URL (default: SMILECDR_BASE_URL env or %(default)s)")
    parser.add_argument("--auth-64", default=os.environ.get("CSIRO_FHIR_AUTH_64"),
                        help="Base64 encoded basic auth credentials "
                             "(default: CSIRO_FHIR_AUTH_64 env var)")
    args = parser.parse_args()

    if not args.auth_64:
        print("Error: no credentials. Set CSIRO_FHIR_AUTH_64 or pass --auth-64.")
        return 1

    nodes = args.node or SUPPORTED_NODES
    if not args.apply:
        print("Dry-run mode: no changes will be made.")

    ok = True
    for node in nodes:
        client = ModuleConfigClient(args.base_url, args.auth_64, node)
        try:
            ok &= reconcile_node(client, node, apply=args.apply, restart=not args.no_restart)
            if args.archive_app_gallery:
                ok &= archive_app_gallery(client, node, apply=args.apply)
        except requests.RequestException as e:
            print(f"  [ERROR] {node}: {e}")
            ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
