#!/usr/bin/env python3
"""
SMART User Management

Creates and manages user accounts on the SmileCDR server for SMART App Launch
clients. Users are needed for the SMART App Launch (Authorization Code) flow
where a person logs in and authorizes the app.

Backend Service clients do NOT need user accounts — they authenticate directly
with client credentials.

API Reference:
    SmileCDR User Management Endpoint:
    https://smilecdr.com/docs/json_admin_endpoints/user_management_endpoint.html

    POST /admin-json/user-management/{nodeId}/{moduleId}  - Create user
    GET  /admin-json/user-management/{nodeId}/{moduleId}?searchTerm=...  - Search
    PUT  /admin-json/user-management/{nodeId}/{moduleId}/{pid}  - Update user

Usage:
    # Create a single user (read-only)
    python manage_smart_users.py \\
        --username connectathon-user-01 \\
        --password "SecurePass123" \\
        --given-name "Connectathon" \\
        --family-name "User 01" \\
        --permissions read-only

    # Create a single user (read+write) with practitioner launch context
    python manage_smart_users.py \\
        --username connectathon-user-02 \\
        --password "SecurePass456" \\
        --given-name "Connectathon" \\
        --family-name "User 02" \\
        --permissions read-write \\
        --practitioner-id guthrie-aaron

    # Bulk create from JSON file
    python manage_smart_users.py \\
        --bulk --users-file module-config/connectathon-users.json

    # Dry run
    python manage_smart_users.py \\
        --bulk --users-file module-config/connectathon-users.json --dry-run

Environment Variables:
    CSIRO_FHIR_AUTH_64: Base64 encoded basic auth credentials (admin account)
    SMILECDR_BASE_URL: Base URL (default: https://smile.sparked-fhir.com)

Workflow Integration (not yet implemented):
    This script could be wired into a GitHub Actions workflow similar to
    register-smart-clients.yml. Potential triggers:
    - workflow_dispatch for bulk connectathon user creation
    - workflow_call from issue-labeled.yml when a user account is requested
    - An issue template (e.g., 06-smart-user-request.yml) could collect:
      username, display name, permissions level, practitioner ID
    See register_smart_client.py and .github/workflows/register-smart-clients.yml
    for the pattern to follow.
"""

import argparse
import json
import os
import secrets
import string
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
# The security module ID for the aucore node. This is the Local Inbound Security
# module which manages users who authenticate via the SMART auth login page.
# The smart_auth (SMART Outbound Security) module depends on this for username/password auth.
SECURITY_MODULE_ID = "local_security"
ADMIN_JSON_PATH = f"{NODE_ID}/admin-json"
USER_MGMT_PATH = f"user-management/{NODE_ID}/{SECURITY_MODULE_ID}"

DEFAULT_PARTITION = "DEFAULT"


# =============================================================================
# Permission Presets
# =============================================================================

def build_authorities(permission_level: str = "read-only") -> List[Dict]:
    """Build SmileCDR authorities for a user based on a permission level preset.

    These authorities determine what the user can do when they log in and
    authorize a SMART App Launch client. The effective access is the intersection
    of the user's authorities and the SMART scopes granted to the app.

    Args:
        permission_level: One of "read-only", "read-write", or "superuser".
    """
    authorities = [
        {"permission": "ROLE_FHIR_CLIENT"},
        {"permission": "FHIR_CAPABILITIES"},
        {"permission": "FHIR_ACCESS_PARTITION_NAME", "argument": DEFAULT_PARTITION},
        {"permission": "FHIR_ALL_READ"},
    ]

    if permission_level in ("read-write", "superuser"):
        authorities.append({"permission": "FHIR_ALL_WRITE"})
        authorities.append({"permission": "FHIR_TRANSACTION"})

    if permission_level == "superuser":
        # Replace all of the above with the superuser shortcut
        authorities = [{"permission": "ROLE_FHIR_CLIENT_SUPERUSER"}]

    return authorities


# =============================================================================
# Payload Builder
# =============================================================================

def build_user_payload(
    username: str,
    password: str,
    given_name: str = "",
    family_name: str = "",
    email: str = "",
    permission_level: str = "read-only",
    practitioner_id: Optional[str] = None,
    patient_id: Optional[str] = None,
) -> Dict:
    """Build the JSON payload for creating a SmileCDR user.

    Args:
        username: Login username (must be unique).
        password: Login password.
        given_name: User's given/first name.
        family_name: User's family/last name.
        email: User's email address.
        permission_level: "read-only", "read-write", or "superuser".
        practitioner_id: FHIR Practitioner resource ID for launch context
                         (e.g., "guthrie-aaron"). Used for EHR launch.
        patient_id: FHIR Patient resource ID for default patient launch context.
    """
    payload = {
        "username": username,
        "password": password,
        "familyName": family_name or username,
        "givenName": given_name or "Connectathon",
        "accountLocked": False,
        "accountDisabled": False,
        "systemUser": False,
        "serviceAccount": False,
        "external": False,
        "authorities": build_authorities(permission_level),
    }

    if email:
        payload["email"] = email

    # Default launch contexts for SMART EHR launch
    # See: https://smilecdr.com/docs/smart/smart_on_fhir_outbound_security_module_context_selection.html
    launch_contexts = []
    if practitioner_id:
        launch_contexts.append({
            "contextType": "practitioner",
            "resourceId": f"Practitioner/{practitioner_id}" if "/" not in practitioner_id else practitioner_id,
        })
    if patient_id:
        launch_contexts.append({
            "contextType": "patient",
            "resourceId": f"Patient/{patient_id}" if "/" not in patient_id else patient_id,
        })

    if launch_contexts:
        payload["defaultLaunchContexts"] = launch_contexts

    return payload


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class UserResult:
    username: str
    success: bool
    status_code: Optional[int] = None
    error_message: Optional[str] = None
    already_exists: bool = False
    dry_run: bool = False
    permission_level: str = "read-only"


@dataclass
class UserSummary:
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    duration_seconds: float = 0.0
    dry_run: bool = False
    results: List[UserResult] = field(default_factory=list)


# =============================================================================
# Helpers
# =============================================================================

def redact_password(payload: Dict) -> Dict:
    """Return a copy of the payload with password redacted for safe logging."""
    import copy
    redacted = copy.deepcopy(payload)
    if "password" in redacted:
        redacted["password"] = "***REDACTED***"
    return redacted


def generate_password(length: int = 16) -> str:
    """Generate a random password with letters, digits, and punctuation."""
    chars = string.ascii_letters + string.digits + "!@#$%&*"
    return "".join(secrets.choice(chars) for _ in range(length))


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
# User Manager
# =============================================================================

class SmartUserManager:
    """Manages SmileCDR users via the Admin JSON User Management API."""

    def __init__(self, base_url: str, auth_header: str, dry_run: bool = False,
                 skip_existing: bool = True):
        self.base_url = base_url.rstrip("/")
        self.admin_url = f"{self.base_url}/{ADMIN_JSON_PATH}"
        self.dry_run = dry_run
        self.skip_existing = skip_existing
        self.session = create_session(auth_header)

    def _user_url(self) -> str:
        return f"{self.admin_url}/{USER_MGMT_PATH}"

    def check_user_exists(self, username: str) -> bool:
        """Check if a user already exists by searching for the username.

        Note: The SmileCDR search is fuzzy, so we filter by exact match.
        """
        try:
            resp = self.session.get(
                self._user_url(),
                params={"searchTerm": username, "pageSize": 50},
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                users = data.get("users", [])
                return any(u.get("username", "").lower() == username.lower() for u in users)
            return False
        except requests.RequestException:
            return False

    def create_user(self, payload: Dict) -> UserResult:
        """Create a single user account."""
        username = payload.get("username", "unknown")
        permission_level = "unknown"
        # Infer permission level from authorities for reporting
        auths = {a.get("permission") for a in payload.get("authorities", [])}
        if "ROLE_FHIR_CLIENT_SUPERUSER" in auths:
            permission_level = "superuser"
        elif "FHIR_ALL_WRITE" in auths:
            permission_level = "read-write"
        elif "FHIR_ALL_READ" in auths:
            permission_level = "read-only"

        if self.dry_run:
            print(f"  [DRY RUN] Would create user: {username} ({permission_level})")
            print(f"  Payload: {json.dumps(redact_password(payload), indent=2)}")
            return UserResult(
                username=username,
                success=True,
                dry_run=True,
                permission_level=permission_level,
            )

        if self.skip_existing and self.check_user_exists(username):
            print(f"  [SKIP] User already exists: {username}")
            return UserResult(
                username=username,
                success=True,
                already_exists=True,
                permission_level=permission_level,
            )

        try:
            resp = self.session.post(
                self._user_url(),
                json=payload,
                timeout=30,
            )

            if resp.status_code in (200, 201):
                print(f"  [OK] Created user: {username}")
                return UserResult(
                    username=username,
                    success=True,
                    status_code=resp.status_code,
                    permission_level=permission_level,
                )
            else:
                error_detail = resp.text[:500] if resp.text else "No response body"
                print(f"  [FAIL] {username}: HTTP {resp.status_code} - {error_detail}")
                return UserResult(
                    username=username,
                    success=False,
                    status_code=resp.status_code,
                    error_message=error_detail,
                    permission_level=permission_level,
                )

        except requests.RequestException as e:
            print(f"  [ERROR] {username}: {e}")
            return UserResult(
                username=username,
                success=False,
                error_message=str(e),
                permission_level=permission_level,
            )

    def create_single(self, username: str, password: str, given_name: str = "",
                      family_name: str = "", email: str = "",
                      permission_level: str = "read-only",
                      practitioner_id: Optional[str] = None,
                      patient_id: Optional[str] = None) -> UserResult:
        """Create a single user by arguments."""
        payload = build_user_payload(
            username=username,
            password=password,
            given_name=given_name,
            family_name=family_name,
            email=email,
            permission_level=permission_level,
            practitioner_id=practitioner_id,
            patient_id=patient_id,
        )
        return self.create_user(payload)

    def create_bulk(self, users_file: str) -> tuple:
        """Create multiple users from a JSON file.

        Returns (UserSummary, credentials_list) where credentials_list is a list
        of {"username": ..., "password": ...} for successfully created users.
        """
        start_time = time.time()

        with open(users_file, "r") as f:
            data = json.load(f)

        users = data.get("users", [])
        summary = UserSummary(
            total=len(users),
            dry_run=self.dry_run,
        )
        credentials = []

        print(f"\nCreating {len(users)} users from {users_file}")
        if self.dry_run:
            print("[DRY RUN MODE - no changes will be made]\n")

        for user_def in users:
            # Auto-generate password if not specified
            password = user_def.get("password") or generate_password()

            result = self.create_single(
                username=user_def["username"],
                password=password,
                given_name=user_def.get("givenName", ""),
                family_name=user_def.get("familyName", ""),
                email=user_def.get("email", ""),
                permission_level=user_def.get("permissionLevel", "read-only"),
                practitioner_id=user_def.get("practitionerId"),
                patient_id=user_def.get("patientId"),
            )
            summary.results.append(result)

            if result.success and not result.already_exists:
                summary.succeeded += 1
                credentials.append({"username": user_def["username"], "password": password})
            elif result.already_exists:
                summary.skipped += 1
            else:
                summary.failed += 1

        summary.duration_seconds = round(time.time() - start_time, 2)
        return summary, credentials


# =============================================================================
# Summary Generators
# =============================================================================

def generate_summary_markdown(summary: UserSummary) -> str:
    """Generate markdown summary for GitHub Actions step summary."""
    mode = " (DRY RUN)" if summary.dry_run else ""
    lines = [
        f"## SMART User Creation Summary{mode}\n",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Total | {summary.total} |",
        f"| Created | {summary.succeeded} |",
        f"| Skipped (existing) | {summary.skipped} |",
        f"| Failed | {summary.failed} |",
        f"| Duration | {summary.duration_seconds}s |",
        "",
    ]

    if summary.results:
        lines.append("### Results\n")
        lines.append("| Username | Permissions | Status |")
        lines.append("|----------|-------------|--------|")
        for r in summary.results:
            if r.dry_run:
                status = "Would create"
            elif r.already_exists:
                status = "Skipped (exists)"
            elif r.success:
                status = "Created"
            else:
                status = f"Failed: {r.error_message or 'Unknown error'}"
            lines.append(f"| `{r.username}` | {r.permission_level} | {status} |")

    return "\n".join(lines)


def generate_summary_json(summary: UserSummary) -> str:
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
                "username": r.username,
                "permission_level": r.permission_level,
                "success": r.success,
                "already_exists": r.already_exists,
                "error_message": r.error_message,
                # Never include passwords in JSON summary
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
        description="Create and manage SmileCDR users for SMART App Launch",
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

    # Single user options
    parser.add_argument("--username", help="Login username")
    parser.add_argument("--password", help="Login password (auto-generated if omitted)")
    parser.add_argument("--given-name", default="", help="User's given/first name")
    parser.add_argument("--family-name", default="", help="User's family/last name")
    parser.add_argument("--email", default="", help="User's email address")
    parser.add_argument("--permissions",
                        choices=["read-only", "read-write", "superuser"],
                        default="read-only",
                        help="Permission level (default: read-only)")
    parser.add_argument("--practitioner-id",
                        help="Practitioner resource ID for EHR launch context (e.g., guthrie-aaron)")
    parser.add_argument("--patient-id",
                        help="Patient resource ID for default patient launch context")

    # Bulk options
    parser.add_argument("--bulk", action="store_true",
                        help="Bulk create users from JSON file")
    parser.add_argument("--users-file",
                        help="Path to JSON file with user definitions")

    # Behavior options
    parser.add_argument("--dry-run", action="store_true", default=False,
                        help="Preview without making changes")
    parser.add_argument("--skip-existing", action="store_true", default=True,
                        help="Skip users that already exist (default: true)")
    parser.add_argument("--no-skip-existing", dest="skip_existing", action="store_false",
                        help="Fail if user already exists")

    # Output options
    parser.add_argument("--summary-file", default=None,
                        help="Write JSON summary to this file")
    parser.add_argument("--credentials-file", default=None,
                        help="Write generated credentials (username:password) to this file (bulk mode)")
    parser.add_argument("--github-step-summary",
                        default=os.getenv("GITHUB_STEP_SUMMARY"),
                        help="Write markdown to GitHub step summary file")

    args = parser.parse_args()

    if not args.auth_header:
        print("Error: --auth-header or CSIRO_FHIR_AUTH_64 environment variable is required")
        sys.exit(1)

    manager = SmartUserManager(
        base_url=args.base_url,
        auth_header=args.auth_header,
        dry_run=args.dry_run,
        skip_existing=args.skip_existing,
    )

    if args.bulk:
        if not args.users_file:
            print("Error: --users-file is required with --bulk")
            sys.exit(1)

        summary, credentials = manager.create_bulk(args.users_file)

        md = generate_summary_markdown(summary)
        print(f"\n{md}")

        # Output credentials for newly created users
        if credentials and not args.dry_run:
            if args.credentials_file:
                with open(args.credentials_file, "w") as f:
                    for cred in credentials:
                        f.write(f"{cred['username']}\t{cred['password']}\n")
                print(f"\nCredentials written to: {args.credentials_file}")
                print("WARNING: This file contains passwords. Distribute securely and delete after use.")
            else:
                print(f"\n** Credentials for {len(credentials)} created users (save these — passwords are not recoverable) **")
                for cred in credentials:
                    print(f"   {cred['username']}\t{cred['password']}")

        if args.github_step_summary:
            with open(args.github_step_summary, "a") as f:
                f.write(md + "\n")

        if args.summary_file:
            with open(args.summary_file, "w") as f:
                f.write(generate_summary_json(summary))

        if summary.failed > 0:
            sys.exit(1)

    else:
        if not args.username:
            print("Error: --username is required for single user creation")
            sys.exit(1)

        password = args.password or generate_password()

        start_time = time.time()
        result = manager.create_single(
            username=args.username,
            password=password,
            given_name=args.given_name,
            family_name=args.family_name,
            email=args.email,
            permission_level=args.permissions,
            practitioner_id=args.practitioner_id,
            patient_id=args.patient_id,
        )
        duration = round(time.time() - start_time, 2)

        summary = UserSummary(
            total=1,
            succeeded=1 if result.success and not result.already_exists else 0,
            failed=0 if result.success else 1,
            skipped=1 if result.already_exists else 0,
            duration_seconds=duration,
            dry_run=args.dry_run,
            results=[result],
        )

        md = generate_summary_markdown(summary)
        print(f"\n{md}")

        # Print the password for single user creation (not in bulk mode for safety)
        if result.success and not result.already_exists and not args.dry_run:
            print(f"\n** Credentials (save these — password is not recoverable) **")
            print(f"   Username: {args.username}")
            print(f"   Password: {password}")

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
