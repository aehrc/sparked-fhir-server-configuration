#!/usr/bin/env python3
"""
FHIR Test Data Clearer

Deletes FHIR test data from a FHIR server, either by targeting specific resources
from a test data set (targeted mode) or by wiping all resources on the node (wipe-all mode).

Usage:
    # Targeted: delete only resources found in a test data directory
    python clear_test_data.py \\
        --mode targeted \\
        --fhir-url https://smile.sparked-fhir.com/ereq/fhir/DEFAULT \\
        --data-dir /path/to/test-data

    # Wipe all resources on a node
    python clear_test_data.py \\
        --mode wipe-all \\
        --fhir-url https://smile.sparked-fhir.com/ereq/fhir/DEFAULT

    # Dry run (show what would be deleted)
    python clear_test_data.py \\
        --mode targeted \\
        --fhir-url https://smile.sparked-fhir.com/ereq/fhir/DEFAULT \\
        --data-dir /path/to/test-data \\
        --dry-run

Environment Variables:
    FHIR_AUTH_HEADER: Base64 encoded basic auth credentials
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    print("Error: 'requests' library is required. Install with: pip install requests")
    sys.exit(1)


# Resource types to search for in wipe-all mode, ordered by typical FHIR dependency
# (leaf resources first, base resources last) — reverse of upload order
RESOURCE_TYPES_DELETE_ORDER = [
    'Task',
    'Bundle',
    'Consent',
    'CommunicationRequest',
    'ServiceRequest',
    'DocumentReference',
    'MedicationStatement',
    'MedicationRequest',
    'Immunization',
    'AllergyIntolerance',
    'DiagnosticReport',
    'Observation',
    'Procedure',
    'Condition',
    'Medication',
    'Specimen',
    'Encounter',
    'Coverage',
    'Device',
    'RelatedPerson',
    'Patient',
    'PractitionerRole',
    'HealthcareService',
    'Practitioner',
    'Location',
    'Organization',
]


@dataclass
class DeleteResult:
    resource_type: str
    resource_id: str
    success: bool
    status_code: Optional[int] = None
    error_message: Optional[str] = None
    already_gone: bool = False


@dataclass
class DeleteSummary:
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    already_gone: int = 0
    skipped: int = 0
    duration_seconds: float = 0.0
    results: List[DeleteResult] = field(default_factory=list)
    errors: List[DeleteResult] = field(default_factory=list)


class FHIRResourceDeleter:
    """Deletes FHIR resources from a server with retry and dependency-aware ordering."""

    def __init__(self, fhir_url: str, auth_header: str, expunge: bool = False,
                 dry_run: bool = False, continue_on_error: bool = True,
                 batch_size: int = 50, max_conflict_retries: int = 3):
        self.fhir_url = fhir_url.rstrip('/')
        self.expunge = expunge
        self.dry_run = dry_run
        self.continue_on_error = continue_on_error
        self.batch_size = batch_size
        self.max_conflict_retries = max_conflict_retries

        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/fhir+json',
            'Authorization': f'Basic {auth_header}',
        })

        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        self.session.mount('https://', adapter)
        self.session.mount('http://', adapter)

    def delete_resources(self, resource_ids: List[Tuple[str, str]]) -> DeleteSummary:
        """Delete a list of (resource_type, resource_id) pairs in batches."""
        summary = DeleteSummary(total=len(resource_ids))
        start_time = time.time()

        if not resource_ids:
            print("No resources to delete.")
            summary.duration_seconds = round(time.time() - start_time, 1)
            return summary

        total_batches = (len(resource_ids) + self.batch_size - 1) // self.batch_size

        # Track resources that need retry due to 409 conflicts
        retry_queue: List[Tuple[str, str]] = []
        retry_count = 0

        for batch_idx in range(total_batches):
            batch_start = batch_idx * self.batch_size
            batch_end = min(batch_start + self.batch_size, len(resource_ids))
            batch = resource_ids[batch_start:batch_end]

            print(f"\nDeleting: Batch {batch_idx + 1}/{total_batches} "
                  f"[{batch_start + 1}-{batch_end} of {len(resource_ids)}]")

            if self.dry_run:
                for rtype, rid in batch:
                    print(f"  [DRY RUN] Would delete {rtype}/{rid}")
                summary.skipped += len(batch)
                continue

            batch_success = 0
            batch_fail = 0
            auth_failed = False

            for resource_type, resource_id in batch:
                result = self._delete_single(resource_type, resource_id)
                summary.results.append(result)

                if result.success:
                    summary.succeeded += 1
                    batch_success += 1
                elif result.already_gone:
                    summary.already_gone += 1
                    summary.succeeded += 1
                    batch_success += 1
                elif result.status_code == 409:
                    # Referential integrity conflict — queue for retry
                    retry_queue.append((resource_type, resource_id))
                    summary.failed += 1
                    batch_fail += 1
                else:
                    summary.failed += 1
                    batch_fail += 1
                    summary.errors.append(result)

                    if result.status_code in (401, 403):
                        print(f"  Authentication failed ({result.status_code}). Aborting.")
                        auth_failed = True
                        break

            print(f"  Batch complete: {batch_success} deleted, {batch_fail} failed")

            if auth_failed:
                break

            if batch_fail > 0 and not self.continue_on_error:
                print(f"  Stopping due to errors (continue_on_error=false)")
                break

        # Retry 409 conflicts (resources that had referential integrity issues)
        while retry_queue and retry_count < self.max_conflict_retries:
            retry_count += 1
            print(f"\nRetrying {len(retry_queue)} conflict(s) (attempt {retry_count}/{self.max_conflict_retries})...")

            next_retry: List[Tuple[str, str]] = []
            for resource_type, resource_id in retry_queue:
                result = self._delete_single(resource_type, resource_id)

                # Update summary: remove old failure, add new result
                summary.failed -= 1

                if result.success or result.already_gone:
                    summary.succeeded += 1
                elif result.status_code == 409:
                    next_retry.append((resource_type, resource_id))
                    summary.failed += 1
                else:
                    summary.failed += 1
                    summary.errors.append(result)

            retry_queue = next_retry
            if retry_queue:
                print(f"  {len(retry_queue)} resource(s) still have conflicts")

        # If still have unresolved conflicts, add them to errors
        for resource_type, resource_id in retry_queue:
            summary.errors.append(DeleteResult(
                resource_type=resource_type,
                resource_id=resource_id,
                success=False,
                status_code=409,
                error_message=f"Referential integrity conflict after {self.max_conflict_retries} retries",
            ))

        summary.duration_seconds = round(time.time() - start_time, 1)
        return summary

    def _delete_single(self, resource_type: str, resource_id: str) -> DeleteResult:
        """Delete a single resource, optionally followed by $expunge."""
        url = f"{self.fhir_url}/{resource_type}/{resource_id}"

        try:
            response = self.session.delete(url, timeout=30)

            if response.status_code in (200, 204):
                indicator = "ok"
                print(f"  DELETE {resource_type}/{resource_id} ... {response.status_code} {indicator}")

                # Optionally expunge
                if self.expunge:
                    self._expunge_single(resource_type, resource_id)

                return DeleteResult(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    success=True,
                    status_code=response.status_code,
                )

            elif response.status_code == 404:
                print(f"  DELETE {resource_type}/{resource_id} ... 404 (already gone)")
                return DeleteResult(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    success=False,
                    status_code=404,
                    already_gone=True,
                )

            elif response.status_code == 409:
                error_msg = response.text[:300] if response.text else "Referential integrity conflict"
                print(f"  DELETE {resource_type}/{resource_id} ... 409 CONFLICT (will retry)")
                return DeleteResult(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    success=False,
                    status_code=409,
                    error_message=error_msg,
                )

            else:
                error_msg = response.text[:500] if response.text else f"HTTP {response.status_code}"
                print(f"  DELETE {resource_type}/{resource_id} ... {response.status_code} FAIL")
                print(f"       {error_msg[:200]}")
                return DeleteResult(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    success=False,
                    status_code=response.status_code,
                    error_message=error_msg,
                )

        except requests.exceptions.RequestException as e:
            error_msg = str(e)[:500]
            print(f"  DELETE {resource_type}/{resource_id} ... ERROR")
            print(f"       {error_msg[:200]}")
            return DeleteResult(
                resource_type=resource_type,
                resource_id=resource_id,
                success=False,
                error_message=error_msg,
            )

    def _expunge_single(self, resource_type: str, resource_id: str):
        """Call $expunge on a resource to physically remove it."""
        url = f"{self.fhir_url}/{resource_type}/{resource_id}/$expunge"
        payload = {
            "resourceType": "Parameters",
            "parameter": [
                {"name": "expungeDeletedResources", "valueBoolean": True},
                {"name": "expungePreviousVersions", "valueBoolean": True},
            ],
        }

        try:
            response = self.session.post(url, json=payload, timeout=30)
            if response.status_code in (200, 204):
                print(f"       $expunge {resource_type}/{resource_id} ... ok")
            else:
                print(f"       $expunge {resource_type}/{resource_id} ... {response.status_code} (non-critical)")
        except requests.exceptions.RequestException as e:
            print(f"       $expunge {resource_type}/{resource_id} ... error (non-critical): {str(e)[:100]}")


# ---------------------------------------------------------------------------
# Resource discovery: targeted mode (from test data files)
# ---------------------------------------------------------------------------

def discover_ids_from_files(data_dir: Path, exclude_patterns: List[str]) -> List[Tuple[str, str]]:
    """Parse JSON files in data_dir to extract (resourceType, id) pairs.

    Handles both individual resource files and Bundle files (extracting entries).
    Returns pairs in reverse dependency order for safe deletion.
    """
    print(f"\nDiscovering resources from files in {data_dir}...")
    seen: Set[str] = set()
    resources_by_type: Dict[str, List[str]] = defaultdict(list)

    json_files = sorted(data_dir.rglob("*.json"))
    total_files = 0
    parse_errors = 0

    for json_file in json_files:
        parts = json_file.relative_to(data_dir).parts
        if any(pattern in parts for pattern in exclude_patterns):
            continue
        total_files += 1

        try:
            with open(json_file, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"  Warning: Could not parse {json_file.name}: {e}")
            parse_errors += 1
            continue

        resource_type = data.get('resourceType')
        resource_id = data.get('id')

        if not resource_type:
            continue

        # Handle Bundle files — extract individual entries
        if resource_type == 'Bundle':
            entries = data.get('entry', [])
            for entry in entries:
                entry_resource = entry.get('resource', {})
                entry_type = entry_resource.get('resourceType')
                entry_id = entry_resource.get('id')
                if entry_type and entry_id:
                    key = f"{entry_type}/{entry_id}"
                    if key not in seen:
                        seen.add(key)
                        resources_by_type[entry_type].append(entry_id)

            # Also include the Bundle itself if it has an id
            if resource_id:
                key = f"{resource_type}/{resource_id}"
                if key not in seen:
                    seen.add(key)
                    resources_by_type[resource_type].append(resource_id)
        else:
            if resource_id:
                key = f"{resource_type}/{resource_id}"
                if key not in seen:
                    seen.add(key)
                    resources_by_type[resource_type].append(resource_id)

    print(f"  Scanned {total_files} files ({parse_errors} parse errors)")
    print(f"  Found {len(seen)} unique resources across {len(resources_by_type)} types")

    # Build ordered list — reverse dependency order for deletion
    return _order_for_deletion(resources_by_type)


# ---------------------------------------------------------------------------
# Resource discovery: wipe-all mode (from FHIR server search)
# ---------------------------------------------------------------------------

def discover_ids_from_server(session: requests.Session, fhir_url: str,
                             resource_types: Optional[List[str]] = None) -> List[Tuple[str, str]]:
    """Search the FHIR server to discover all resource IDs.

    Paginates through search results for each resource type.
    Returns pairs in reverse dependency order for safe deletion.
    """
    fhir_url = fhir_url.rstrip('/')
    types_to_search = resource_types or RESOURCE_TYPES_DELETE_ORDER

    print(f"\nDiscovering resources from server {fhir_url}...")
    resources_by_type: Dict[str, List[str]] = defaultdict(list)

    for resource_type in types_to_search:
        ids = _search_resource_type(session, fhir_url, resource_type)
        if ids:
            resources_by_type[resource_type] = ids
            print(f"  {resource_type}: {len(ids)} resources")

    total = sum(len(ids) for ids in resources_by_type.values())
    print(f"\n  Total: {total} resources across {len(resources_by_type)} types")

    return _order_for_deletion(resources_by_type)


def _search_resource_type(session: requests.Session, fhir_url: str,
                          resource_type: str) -> List[str]:
    """Search for all resources of a given type, paginating through results."""
    ids = []
    url = f"{fhir_url}/{resource_type}?_count=200&_elements=id"

    while url:
        try:
            response = session.get(url, timeout=30)
            if response.status_code != 200:
                print(f"  Warning: Search {resource_type} returned {response.status_code}")
                break

            bundle = response.json()
            entries = bundle.get('entry', [])

            for entry in entries:
                resource = entry.get('resource', {})
                rid = resource.get('id')
                if rid:
                    ids.append(rid)

            # Follow pagination links
            url = None
            for link in bundle.get('link', []):
                if link.get('relation') == 'next':
                    url = link.get('url')
                    break

        except requests.exceptions.RequestException as e:
            print(f"  Warning: Error searching {resource_type}: {str(e)[:200]}")
            break
        except (json.JSONDecodeError, KeyError) as e:
            print(f"  Warning: Error parsing {resource_type} search results: {e}")
            break

    return ids


def _order_for_deletion(resources_by_type: Dict[str, List[str]]) -> List[Tuple[str, str]]:
    """Order resources for deletion: leaf types first, base types last."""
    # Build type order map — types in RESOURCE_TYPES_DELETE_ORDER get their index,
    # unknown types go to the front (deleted first since they're likely leaf resources)
    type_order = {t: i for i, t in enumerate(RESOURCE_TYPES_DELETE_ORDER)}

    ordered_types = sorted(
        resources_by_type.keys(),
        key=lambda t: type_order.get(t, -1)
    )

    result = []
    for resource_type in ordered_types:
        for resource_id in resources_by_type[resource_type]:
            result.append((resource_type, resource_id))

    return result


# ---------------------------------------------------------------------------
# Summary generation
# ---------------------------------------------------------------------------

def generate_summary_markdown(summary: DeleteSummary, mode: str, fhir_url: str) -> str:
    """Generate GitHub Actions step summary as markdown."""
    if summary.failed == 0 and summary.skipped == 0:
        status_label = "Success"
    elif summary.skipped > 0:
        status_label = "Dry Run"
    else:
        status_label = "Completed with errors"

    lines = [
        "## FHIR Test Data Clear Results",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Status | {status_label} |",
        f"| Mode | {mode} |",
        f"| Target | `{fhir_url}` |",
        f"| Total Resources | {summary.total} |",
        f"| Deleted | {summary.succeeded} |",
        f"| Already Gone | {summary.already_gone} |",
        f"| Failed | {summary.failed} |",
        f"| Skipped (dry run) | {summary.skipped} |",
        f"| Duration | {summary.duration_seconds}s |",
        "",
    ]

    # Type breakdown
    type_counts: Dict[str, Dict[str, int]] = defaultdict(lambda: {'total': 0, 'ok': 0, 'fail': 0, 'gone': 0})
    for result in summary.results:
        type_counts[result.resource_type]['total'] += 1
        if result.success:
            type_counts[result.resource_type]['ok'] += 1
        elif result.already_gone:
            type_counts[result.resource_type]['gone'] += 1
        else:
            type_counts[result.resource_type]['fail'] += 1

    if type_counts:
        lines.extend([
            "### Resource Type Breakdown",
            "",
            "| Resource Type | Total | Deleted | Already Gone | Failed |",
            "|---------------|-------|---------|--------------|--------|",
        ])
        for rtype in sorted(type_counts.keys()):
            c = type_counts[rtype]
            lines.append(f"| {rtype} | {c['total']} | {c['ok']} | {c['gone']} | {c['fail']} |")
        lines.append("")

    if summary.errors:
        lines.extend([
            "<details>",
            f"<summary>{len(summary.errors)} failures (click to expand)</summary>",
            "",
            "| Resource | Status | Error |",
            "|----------|--------|-------|",
        ])
        for err in summary.errors[:50]:
            error_text = (err.error_message or "Unknown")[:100].replace('|', '\\|').replace('\n', ' ')
            lines.append(f"| {err.resource_type}/{err.resource_id} | {err.status_code or 'N/A'} | {error_text} |")
        if len(summary.errors) > 50:
            lines.append(f"| ... | ... | ({len(summary.errors) - 50} more errors omitted) |")
        lines.extend(["", "</details>", ""])

    return "\n".join(lines)


def generate_summary_json(summary: DeleteSummary, mode: str, fhir_url: str) -> str:
    """Generate JSON summary for machine consumption."""
    if summary.failed == 0 and summary.skipped == 0:
        status = "success"
    elif summary.skipped > 0:
        status = "dry_run"
    else:
        status = "completed_with_errors"

    data = {
        "status": status,
        "total": summary.total,
        "succeeded": summary.succeeded,
        "failed": summary.failed,
        "already_gone": summary.already_gone,
        "skipped": summary.skipped,
        "duration_seconds": summary.duration_seconds,
        "mode": mode,
        "target_url": fhir_url,
        "errors": [
            {
                "resource_type": e.resource_type,
                "resource_id": e.resource_id,
                "status_code": e.status_code,
                "error": (e.error_message or "")[:200],
            }
            for e in summary.errors[:100]
        ],
    }
    return json.dumps(data, indent=2)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Clear FHIR test data from a FHIR server',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument('--mode', choices=['targeted', 'wipe-all'], required=True,
                        help='Delete mode: targeted (from test data files) or wipe-all (everything on node)')
    parser.add_argument('--fhir-url', required=True,
                        help='Target FHIR server base URL')
    parser.add_argument('--auth-header', default=os.getenv('FHIR_AUTH_HEADER'),
                        help='Base64 basic auth header (default: FHIR_AUTH_HEADER env)')
    parser.add_argument('--data-dir', type=Path, default=None,
                        help='Directory containing test data JSON files (required for targeted mode)')
    parser.add_argument('--exclude-patterns', default='vendor-demonstrator',
                        help='Comma-separated directory names to exclude (default: vendor-demonstrator)')
    parser.add_argument('--resource-types', default=None,
                        help='Comma-separated resource types to delete (wipe-all mode filter)')
    parser.add_argument('--expunge', action='store_true', default=False,
                        help='Also $expunge resources after deletion (physical removal)')
    parser.add_argument('--batch-size', type=int, default=50,
                        help='Resources per batch (default: 50)')
    parser.add_argument('--dry-run', action='store_true', default=False,
                        help='Show what would be deleted without making changes')
    parser.add_argument('--continue-on-error', action='store_true', default=True,
                        help='Continue deleting after errors (default: true)')
    parser.add_argument('--fail-on-error', action='store_true', default=False,
                        help='Stop on first error')
    parser.add_argument('--summary-file', type=Path, default=None,
                        help='Write JSON summary to this file')
    parser.add_argument('--github-step-summary', type=Path,
                        default=os.getenv('GITHUB_STEP_SUMMARY'),
                        help='Path to GitHub step summary file')

    args = parser.parse_args()

    # Validate
    if not args.auth_header:
        parser.error('--auth-header (or FHIR_AUTH_HEADER env) is required')

    if args.mode == 'targeted' and not args.data_dir:
        parser.error('--data-dir is required for targeted mode')

    continue_on_error = not args.fail_on_error
    exclude_patterns = [p.strip() for p in args.exclude_patterns.split(',') if p.strip()]

    # Parse resource types filter
    resource_types = None
    if args.resource_types:
        resource_types = [t.strip() for t in args.resource_types.split(',') if t.strip()]

    # Print header
    print("=" * 80)
    print("FHIR Test Data Clearer")
    print("=" * 80)
    print(f"Mode:              {args.mode}")
    print(f"Target:            {args.fhir_url}")
    if args.data_dir:
        print(f"Data dir:          {args.data_dir}")
    if resource_types:
        print(f"Resource types:    {', '.join(resource_types)}")
    print(f"Expunge:           {args.expunge}")
    print(f"Batch size:        {args.batch_size}")
    print(f"Dry run:           {args.dry_run}")
    print(f"Continue on error: {continue_on_error}")
    print("=" * 80)

    # Create deleter (also used for server discovery in wipe-all mode)
    deleter = FHIRResourceDeleter(
        fhir_url=args.fhir_url,
        auth_header=args.auth_header,
        expunge=args.expunge,
        dry_run=args.dry_run,
        continue_on_error=continue_on_error,
        batch_size=args.batch_size,
    )

    # Discover resources to delete
    if args.mode == 'targeted':
        resource_ids = discover_ids_from_files(args.data_dir, exclude_patterns)
        if resource_types:
            resource_ids = [(t, i) for t, i in resource_ids if t in resource_types]
            print(f"  Filtered to {len(resource_ids)} resources matching type filter")
    else:
        resource_ids = discover_ids_from_server(
            deleter.session, args.fhir_url, resource_types
        )

    if not resource_ids:
        print("\nNo resources found to delete.")
        sys.exit(0)

    # Type summary
    type_counts = defaultdict(int)
    for rtype, _ in resource_ids:
        type_counts[rtype] += 1
    type_summary = ", ".join(
        f"{t}({c})" for t, c in sorted(type_counts.items(), key=lambda x: x[1], reverse=True)
    )
    print(f"\nResources to delete: {len(resource_ids)}")
    print(f"  Types: {type_summary}")

    # Delete
    print(f"\n{'=' * 80}")
    print(f"Starting deletion of {len(resource_ids)} resources...")
    print(f"{'=' * 80}")

    summary = deleter.delete_resources(resource_ids)

    # Print summary
    print(f"\n{'=' * 80}")
    print("SUMMARY")
    print(f"{'=' * 80}")
    print(f"Total:        {summary.total}")
    print(f"Deleted:      {summary.succeeded}")
    print(f"Already gone: {summary.already_gone}")
    print(f"Failed:       {summary.failed}")
    print(f"Skipped:      {summary.skipped}")
    print(f"Duration:     {summary.duration_seconds}s")

    if summary.errors:
        print(f"\nFailed resources:")
        for err in summary.errors[:20]:
            print(f"  - {err.resource_type}/{err.resource_id}: "
                  f"{err.status_code or 'N/A'} {err.error_message or ''}")
        if len(summary.errors) > 20:
            print(f"  ... and {len(summary.errors) - 20} more errors")

    if args.dry_run:
        print("\n[DRY RUN] No changes were made")
    elif summary.failed == 0:
        print("\nAll resources deleted successfully!")
    else:
        print(f"\nCompleted with {summary.failed} errors")

    print(f"{'=' * 80}")

    # Write GitHub step summary
    if args.github_step_summary:
        try:
            md = generate_summary_markdown(summary, args.mode, args.fhir_url)
            with open(args.github_step_summary, 'a') as f:
                f.write(md)
            print(f"\nStep summary written to {args.github_step_summary}")
        except OSError as e:
            print(f"\nWarning: Could not write step summary: {e}")

    # Write JSON summary
    if args.summary_file:
        try:
            json_summary = generate_summary_json(summary, args.mode, args.fhir_url)
            with open(args.summary_file, 'w') as f:
                f.write(json_summary)
            print(f"JSON summary written to {args.summary_file}")
        except OSError as e:
            print(f"Warning: Could not write JSON summary: {e}")

    # Exit code
    if summary.failed > 0 and not continue_on_error:
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()
