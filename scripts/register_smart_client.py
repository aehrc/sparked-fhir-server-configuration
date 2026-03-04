#!/usr/bin/env python3
"""
SMART App Client Registration

Registers OpenID Connect / SMART on FHIR clients on the SmileCDR server
via the Admin JSON API.

Usage:
    # Register a SMART App Launch (public) client
    python register_smart_client.py \\
        --client-type smart-app-launch \\
        --client-id my-app \\
        --client-name "My SMART App" \\
        --redirect-uris "https://app.example.com/callback,http://localhost:3000/callback" \\
        --scopes "launch/patient patient/*.read openid fhirUser offline_access"

    # Register a Backend Service (confidential) client
    python register_smart_client.py \\
        --client-type backend-service \\
        --client-id my-backend \\
        --client-name "My Backend Service" \\
        --scopes "system/*.*"

    # Bulk register from JSON file
    python register_smart_client.py \\
        --bulk --clients-file module-config/connectathon-clients.json

    # Dry run
    python register_smart_client.py \\
        --client-type smart-app-launch \\
        --client-id test-app \\
        --client-name "Test" \\
        --redirect-uris "http://localhost:3000/callback" \\
        --scopes "openid" \\
        --dry-run

Environment Variables:
    CSIRO_FHIR_AUTH_64: Base64 encoded basic auth credentials (admin account)
    SMILECDR_BASE_URL: Base URL (default: https://smile.sparked-fhir.com)
"""

import argparse
import copy
import json
import os
import secrets
import sys
import time
from dataclasses import dataclass, field
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
NODE_ID = "aucore"
MODULE_ID = "smart_auth"
ADMIN_JSON_PATH = "aucore/admin-json"
OIDC_CLIENTS_PATH = f"openid-connect-clients/{NODE_ID}/{MODULE_ID}"

# Endpoint URLs for documentation / issue comments
WELL_KNOWN_SUFFIX = f"{NODE_ID}/smartauth/.well-known/openid-configuration"
AUTHORIZE_SUFFIX = f"{NODE_ID}/smartauth/authorize"
TOKEN_SUFFIX = f"{NODE_ID}/smartauth/oauth/token"
FHIR_BASE_SUFFIX = f"{NODE_ID}/fhir/DEFAULT"

DEFAULT_SMART_APP_SCOPES = [
    "launch/patient", "patient/*.read", "openid", "fhirUser", "offline_access"
]
DEFAULT_BACKEND_SCOPES = ["system/*.read"]


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class RegistrationResult:
    client_id: str
    client_name: str
    client_type: str
    success: bool
    status_code: Optional[int] = None
    error_message: Optional[str] = None
    client_secret: Optional[str] = None
    already_exists: bool = False
    dry_run: bool = False


@dataclass
class RegistrationSummary:
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    duration_seconds: float = 0.0
    dry_run: bool = False
    results: List[RegistrationResult] = field(default_factory=list)
    base_url: str = DEFAULT_BASE_URL


# =============================================================================
# Payload Builders
# =============================================================================

def build_smart_app_launch_payload(
    client_id: str,
    client_name: str,
    redirect_uris: List[str],
    scopes: List[str],
    access_token_timeout: int = 3600,
    refresh_token_timeout: int = 86400,
) -> Dict:
    """Build payload for a SMART App Launch (public) client.

    Public clients use Authorization Code + PKCE, no client secret.
    Suitable for browser-based or mobile SMART apps.
    """
    return {
        "nodeId": NODE_ID,
        "moduleId": MODULE_ID,
        "clientId": client_id,
        "clientName": client_name,
        "enabled": True,
        "allowedGrantTypes": ["AUTHORIZATION_CODE", "REFRESH_TOKEN"],
        "secretRequired": False,
        "fixedScope": False,
        "scopes": scopes,
        "autoApproveScopes": [],
        "autoGrantScopes": [],
        "registeredRedirectUris": redirect_uris,
        "accessTokenValiditySeconds": access_token_timeout,
        "refreshTokenValiditySeconds": refresh_token_timeout,
        "canIntrospectOwnTokens": True,
        "canIntrospectAnyTokens": False,
        "canReissueTokens": True,
        "alwaysRequireApproval": False,
        "rememberApprovedScopes": True,
        "attestationAccepted": True,
    }


def build_backend_service_payload(
    client_id: str,
    client_name: str,
    scopes: List[str],
    client_secret: Optional[str] = None,
    access_token_timeout: int = 3600,
) -> Dict:
    """Build payload for a Backend Service (confidential) client.

    Confidential clients use Client Credentials grant with a secret.
    Suitable for server-to-server / machine-to-machine integration.
    """
    if client_secret is None:
        client_secret = secrets.token_urlsafe(32)

    return {
        "nodeId": NODE_ID,
        "moduleId": MODULE_ID,
        "clientId": client_id,
        "clientName": client_name,
        "enabled": True,
        "allowedGrantTypes": ["CLIENT_CREDENTIALS"],
        "secretRequired": True,
        "clientSecrets": [{"secret": client_secret}],
        "fixedScope": True,
        "scopes": scopes,
        "autoApproveScopes": [],
        "autoGrantScopes": scopes,
        "registeredRedirectUris": [],
        "accessTokenValiditySeconds": access_token_timeout,
        "canIntrospectOwnTokens": True,
        "canIntrospectAnyTokens": False,
        "canReissueTokens": False,
        "attestationAccepted": True,
        "_generated_secret": client_secret,
    }


# =============================================================================
# Helpers
# =============================================================================

def redact_secrets(payload: Dict) -> Dict:
    """Return a copy of the payload with secrets redacted for safe logging."""
    redacted = copy.deepcopy(payload)
    if "clientSecrets" in redacted:
        redacted["clientSecrets"] = [{"secret": "***REDACTED***"}]
    redacted.pop("_generated_secret", None)
    return redacted


def create_session(auth_header: str) -> requests.Session:
    """Create a requests session with retry logic and auth."""
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


# =============================================================================
# Registrar
# =============================================================================

class SmartClientRegistrar:
    """Registers SMART/OIDC clients via SmileCDR Admin JSON API."""

    def __init__(self, base_url: str, auth_header: str, dry_run: bool = False,
                 skip_existing: bool = True):
        self.base_url = base_url.rstrip("/")
        self.admin_url = f"{self.base_url}/{ADMIN_JSON_PATH}"
        self.dry_run = dry_run
        self.skip_existing = skip_existing
        self.session = create_session(auth_header)

    def _client_url(self, client_id: Optional[str] = None) -> str:
        if client_id:
            return f"{self.admin_url}/{OIDC_CLIENTS_PATH}/{client_id}"
        return f"{self.admin_url}/{OIDC_CLIENTS_PATH}"

    def check_client_exists(self, client_id: str) -> bool:
        """Check if an OIDC client already exists."""
        try:
            resp = self.session.get(self._client_url(client_id), timeout=30)
            return resp.status_code == 200
        except requests.RequestException:
            return False

    def register_client(self, payload: Dict) -> RegistrationResult:
        """Register a single OIDC client."""
        client_id = payload.get("clientId", "unknown")
        client_name = payload.get("clientName", client_id)
        client_type = "backend-service" if "CLIENT_CREDENTIALS" in payload.get("allowedGrantTypes", []) else "smart-app-launch"
        generated_secret = payload.pop("_generated_secret", None)

        if self.dry_run:
            print(f"  [DRY RUN] Would register: {client_id} ({client_type})")
            print(f"  Payload: {json.dumps(redact_secrets(payload), indent=2)}")
            return RegistrationResult(
                client_id=client_id,
                client_name=client_name,
                client_type=client_type,
                success=True,
                dry_run=True,
            )

        if self.skip_existing and self.check_client_exists(client_id):
            print(f"  [SKIP] Client already exists: {client_id}")
            return RegistrationResult(
                client_id=client_id,
                client_name=client_name,
                client_type=client_type,
                success=True,
                already_exists=True,
            )

        try:
            resp = self.session.post(
                self._client_url(),
                json=payload,
                timeout=30,
            )

            if resp.status_code in (200, 201):
                print(f"  [OK] Registered: {client_id}")
                return RegistrationResult(
                    client_id=client_id,
                    client_name=client_name,
                    client_type=client_type,
                    success=True,
                    status_code=resp.status_code,
                    client_secret=generated_secret,
                )
            else:
                error_detail = resp.text[:500] if resp.text else "No response body"
                print(f"  [FAIL] {client_id}: HTTP {resp.status_code} - {error_detail}")
                return RegistrationResult(
                    client_id=client_id,
                    client_name=client_name,
                    client_type=client_type,
                    success=False,
                    status_code=resp.status_code,
                    error_message=error_detail,
                )

        except requests.RequestException as e:
            print(f"  [ERROR] {client_id}: {e}")
            return RegistrationResult(
                client_id=client_id,
                client_name=client_name,
                client_type=client_type,
                success=False,
                error_message=str(e),
            )

    def register_single(self, client_type: str, client_id: str, client_name: str,
                         redirect_uris: List[str], scopes: List[str]) -> RegistrationResult:
        """Register a single client by type."""
        if client_type == "smart-app-launch":
            payload = build_smart_app_launch_payload(client_id, client_name, redirect_uris, scopes)
        elif client_type == "backend-service":
            payload = build_backend_service_payload(client_id, client_name, scopes)
        else:
            return RegistrationResult(
                client_id=client_id,
                client_name=client_name,
                client_type=client_type,
                success=False,
                error_message=f"Unknown client type: {client_type}",
            )
        return self.register_client(payload)

    def register_bulk(self, clients_file: str) -> RegistrationSummary:
        """Register multiple clients from a JSON file."""
        start_time = time.time()

        with open(clients_file, "r") as f:
            data = json.load(f)

        clients = data.get("clients", [])
        summary = RegistrationSummary(
            total=len(clients),
            dry_run=self.dry_run,
            base_url=self.base_url,
        )

        print(f"\nRegistering {len(clients)} clients from {clients_file}")
        if self.dry_run:
            print("[DRY RUN MODE - no changes will be made]\n")

        for client_def in clients:
            client_type = client_def.get("clientType", "smart-app-launch")
            client_id = client_def["clientId"]
            client_name = client_def.get("clientName", client_id)
            scopes = client_def.get("scopes", DEFAULT_SMART_APP_SCOPES)
            redirect_uris = client_def.get("redirectUris", [])

            result = self.register_single(client_type, client_id, client_name, redirect_uris, scopes)
            summary.results.append(result)

            if result.success and not result.already_exists:
                summary.succeeded += 1
            elif result.already_exists:
                summary.skipped += 1
            else:
                summary.failed += 1

        summary.duration_seconds = round(time.time() - start_time, 2)
        return summary


# =============================================================================
# Summary Generators
# =============================================================================

def generate_summary_markdown(summary: RegistrationSummary) -> str:
    """Generate markdown summary for issue comments / GitHub Actions step summary."""
    mode = " (DRY RUN)" if summary.dry_run else ""
    lines = [
        f"## SMART Client Registration Summary{mode}\n",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total | {summary.total} |",
        f"| Registered | {summary.succeeded} |",
        f"| Skipped (existing) | {summary.skipped} |",
        f"| Failed | {summary.failed} |",
        f"| Duration | {summary.duration_seconds}s |",
        "",
    ]

    if summary.results:
        lines.append("### Results\n")
        lines.append("| Client ID | Type | Status |")
        lines.append("|-----------|------|--------|")
        for r in summary.results:
            if r.dry_run:
                status = "Would register"
            elif r.already_exists:
                status = "Skipped (exists)"
            elif r.success:
                status = "Registered"
            else:
                status = f"Failed: {r.error_message or 'Unknown error'}"
            lines.append(f"| `{r.client_id}` | {r.client_type} | {status} |")

    lines.append("")
    lines.append("### Endpoints\n")
    lines.append("| Endpoint | URL |")
    lines.append("|----------|-----|")
    lines.append(f"| FHIR Base | `{summary.base_url}/{FHIR_BASE_SUFFIX}` |")
    lines.append(f"| Well-Known | `{summary.base_url}/{WELL_KNOWN_SUFFIX}` |")
    lines.append(f"| Authorize | `{summary.base_url}/{AUTHORIZE_SUFFIX}` |")
    lines.append(f"| Token | `{summary.base_url}/{TOKEN_SUFFIX}` |")

    return "\n".join(lines)


def generate_single_client_markdown(result: RegistrationResult, base_url: str) -> str:
    """Generate markdown for a single client registration (for issue comments)."""
    type_label = "SMART App Launch (Public)" if result.client_type == "smart-app-launch" else "Backend Service (Confidential)"

    lines = [
        f"## SMART Client Registered\n",
        f"| Field | Value |",
        f"|-------|-------|",
        f"| Client ID | `{result.client_id}` |",
        f"| Client Name | {result.client_name} |",
        f"| Client Type | {type_label} |",
        "",
        "### Endpoints\n",
        "| Endpoint | URL |",
        "|----------|-----|",
        f"| FHIR Base | `{base_url}/{FHIR_BASE_SUFFIX}` |",
        f"| Well-Known | `{base_url}/{WELL_KNOWN_SUFFIX}` |",
        f"| Authorize | `{base_url}/{AUTHORIZE_SUFFIX}` |",
        f"| Token | `{base_url}/{TOKEN_SUFFIX}` |",
        "",
    ]

    if result.client_type == "smart-app-launch":
        lines.extend([
            "### Next Steps",
            "1. Configure your app with the **Client ID** and endpoints above",
            "2. No client secret is needed (public client with PKCE)",
            "3. Test the authorization flow by visiting the Authorize URL",
            "4. Comment on this issue to confirm everything works",
        ])
    else:
        lines.extend([
            "### Next Steps",
            "1. Configure your app with the **Client ID** and endpoints above",
            "2. **Client Secret**: For security, the secret is NOT posted here.",
            "   Contact the repo admins to receive your client secret securely.",
            "3. Test the Client Credentials flow:",
            "   ```bash",
            f"   curl -X POST {base_url}/{TOKEN_SUFFIX} \\",
            '     -H "Content-Type: application/x-www-form-urlencoded" \\',
            f'     -d "grant_type=client_credentials&client_id={result.client_id}&client_secret=YOUR_SECRET"',
            "   ```",
            "4. Comment on this issue to confirm everything works",
        ])

    return "\n".join(lines)


def generate_summary_json(summary: RegistrationSummary) -> str:
    """Generate JSON summary for machine consumption."""
    data = {
        "total": summary.total,
        "succeeded": summary.succeeded,
        "failed": summary.failed,
        "skipped": summary.skipped,
        "duration_seconds": summary.duration_seconds,
        "dry_run": summary.dry_run,
        "results": [
            {
                "client_id": r.client_id,
                "client_name": r.client_name,
                "client_type": r.client_type,
                "success": r.success,
                "already_exists": r.already_exists,
                "error_message": r.error_message,
                # Never include client_secret in JSON summary
            }
            for r in summary.results
        ],
    }
    return json.dumps(data, indent=2)


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Register SMART/OIDC clients on SmileCDR",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "--base-url",
        default=os.getenv("SMILECDR_BASE_URL", DEFAULT_BASE_URL),
        help=f"SmileCDR base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--auth-header",
        default=os.getenv("CSIRO_FHIR_AUTH_64"),
        help="Base64 encoded basic auth credentials (or set CSIRO_FHIR_AUTH_64 env var)",
    )

    # Single client options
    parser.add_argument("--client-type", choices=["smart-app-launch", "backend-service"],
                        help="Type of client to register")
    parser.add_argument("--client-id", help="Unique client identifier")
    parser.add_argument("--client-name", help="Human-readable client name")
    parser.add_argument("--redirect-uris", default="",
                        help="Comma-separated redirect URIs")
    parser.add_argument("--scopes", default="",
                        help="Space-separated SMART/OIDC scopes")
    parser.add_argument("--contact-email", default="",
                        help="Contact email for the app owner (metadata only)")

    # Bulk options
    parser.add_argument("--bulk", action="store_true",
                        help="Bulk register from JSON file")
    parser.add_argument("--clients-file",
                        help="Path to JSON file with client definitions")

    # Behavior options
    parser.add_argument("--dry-run", action="store_true", default=False,
                        help="Preview without making changes")
    parser.add_argument("--skip-existing", action="store_true", default=True,
                        help="Skip clients that already exist (default: true)")
    parser.add_argument("--no-skip-existing", dest="skip_existing", action="store_false",
                        help="Fail if client already exists")

    # Output options
    parser.add_argument("--summary-file", default=None,
                        help="Write JSON summary to this file")
    parser.add_argument("--github-step-summary",
                        default=os.getenv("GITHUB_STEP_SUMMARY"),
                        help="Write markdown to GitHub step summary file")

    args = parser.parse_args()

    if not args.auth_header:
        print("Error: --auth-header or CSIRO_FHIR_AUTH_64 environment variable is required")
        sys.exit(1)

    registrar = SmartClientRegistrar(
        base_url=args.base_url,
        auth_header=args.auth_header,
        dry_run=args.dry_run,
        skip_existing=args.skip_existing,
    )

    if args.bulk:
        if not args.clients_file:
            print("Error: --clients-file is required with --bulk")
            sys.exit(1)

        summary = registrar.register_bulk(args.clients_file)

        # Write outputs
        md = generate_summary_markdown(summary)
        print(f"\n{md}")

        if args.github_step_summary:
            with open(args.github_step_summary, "a") as f:
                f.write(md + "\n")

        if args.summary_file:
            with open(args.summary_file, "w") as f:
                f.write(generate_summary_json(summary))

        if summary.failed > 0:
            sys.exit(1)

    else:
        if not args.client_type or not args.client_id or not args.client_name:
            print("Error: --client-type, --client-id, and --client-name are required for single registration")
            sys.exit(1)

        redirect_uris = [u.strip() for u in args.redirect_uris.split(",") if u.strip()] if args.redirect_uris else []
        scopes = args.scopes.split() if args.scopes else (
            DEFAULT_SMART_APP_SCOPES if args.client_type == "smart-app-launch" else DEFAULT_BACKEND_SCOPES
        )

        start_time = time.time()
        result = registrar.register_single(
            client_type=args.client_type,
            client_id=args.client_id,
            client_name=args.client_name,
            redirect_uris=redirect_uris,
            scopes=scopes,
        )
        duration = round(time.time() - start_time, 2)

        summary = RegistrationSummary(
            total=1,
            succeeded=1 if result.success and not result.already_exists else 0,
            failed=0 if result.success else 1,
            skipped=1 if result.already_exists else 0,
            duration_seconds=duration,
            dry_run=args.dry_run,
            results=[result],
            base_url=args.base_url,
        )

        md = generate_single_client_markdown(result, args.base_url) if result.success else generate_summary_markdown(summary)
        print(f"\n{md}")

        if args.github_step_summary:
            with open(args.github_step_summary, "a") as f:
                f.write(md + "\n")

        if args.summary_file:
            with open(args.summary_file, "w") as f:
                f.write(generate_summary_json(summary))

        if not result.success:
            sys.exit(1)


if __name__ == "__main__":
    main()
