#!/usr/bin/env python3
# DEPRECATED: This script has been replaced by the sparked-test-data-loader Go tool.
# See: https://github.com/aehrc/sparked-test-data-loader
# This file is kept for reference only. Use the Go tool or the GitHub Actions workflows instead.
"""
FHIR Test Data Loader (DEPRECATED)

Loads FHIR test data to a FHIR server either directly via REST API or via FHIRFlare proxy.

Usage:
    # Direct upload to FHIR server
    python load_test_data.py \\
        --method direct \\
        --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \\
        --data-dir /path/to/test-data

    # Direct upload with transaction mode (atomic batch)
    python load_test_data.py \\
        --method direct \\
        --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \\
        --data-dir /path/to/test-data \\
        --upload-mode transaction

    # Upload via FHIRFlare proxy
    python load_test_data.py \\
        --method fhirflare \\
        --fhir-url https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \\
        --data-dir /path/to/test-data \\
        --upload-mode individual

Environment Variables:
    FHIR_AUTH_HEADER: Base64 encoded basic auth (direct method)
    FHIRFLARE_URL: FHIRFlare base URL (fhirflare method)
    FHIRFLARE_API_KEY: FHIRFlare API key (fhirflare method)
    FHIR_USERNAME: FHIR server username (fhirflare method)
    FHIR_PASSWORD: FHIR server password (fhirflare method)
"""

import argparse
import json
import os
import sys
import time
from abc import ABC, abstractmethod
from collections import defaultdict, deque
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


# Fallback type-level dependency order (used as tiebreaker within topological sort)
RESOURCE_TYPE_ORDER = {
    'Organization': 0,
    'Location': 1,
    'Practitioner': 2,
    'HealthcareService': 3,
    'PractitionerRole': 4,
    'Patient': 5,
    'RelatedPerson': 6,
    'Device': 7,
    'Coverage': 8,
    'Encounter': 9,
    'Specimen': 10,
    'Medication': 11,
    'Condition': 12,
    'Procedure': 13,
    'Observation': 14,
    'DiagnosticReport': 15,
    'AllergyIntolerance': 16,
    'Immunization': 17,
    'MedicationRequest': 18,
    'MedicationStatement': 19,
    'DocumentReference': 20,
    'ServiceRequest': 21,
    'CommunicationRequest': 22,
    'Consent': 23,
    'Task': 24,
    'Bundle': 99,
}
DEFAULT_TYPE_ORDER = 50


@dataclass
class FHIRResource:
    file_path: Path
    resource_type: str
    resource_id: str
    data: dict
    key: str = ""  # "{ResourceType}/{id}" unique key

    def __post_init__(self):
        if not self.key:
            self.key = f"{self.resource_type}/{self.resource_id}" if self.resource_id else ""


@dataclass
class UploadResult:
    file_path: str
    resource_type: str
    resource_id: str
    success: bool
    status_code: Optional[int] = None
    error_message: Optional[str] = None
    method: str = ""


@dataclass
class UploadSummary:
    total_files: int = 0
    successful: int = 0
    failed: int = 0
    skipped: int = 0
    duration_seconds: float = 0.0
    results: List[UploadResult] = field(default_factory=list)
    errors: List[UploadResult] = field(default_factory=list)


# ---------------------------------------------------------------------------
# File discovery, parsing, deduplication
# ---------------------------------------------------------------------------

def discover_files(data_dir: Path, exclude_patterns: List[str]) -> List[Path]:
    """Find all .json files under data_dir, excluding specified directory patterns."""
    files = []
    for json_file in sorted(data_dir.rglob("*.json")):
        parts = json_file.relative_to(data_dir).parts
        if any(pattern in parts for pattern in exclude_patterns):
            continue
        files.append(json_file)
    return files


def parse_fhir_resource(file_path: Path) -> Optional[FHIRResource]:
    """Parse a JSON file into a FHIRResource. Returns None if not valid FHIR."""
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"  Warning: Could not parse {file_path.name}: {e}")
        return None

    resource_type = data.get('resourceType')
    resource_id = data.get('id')

    if not resource_type:
        print(f"  Warning: No resourceType in {file_path.name}, skipping")
        return None

    if not resource_id:
        print(f"  Warning: No id in {file_path.name}, will use POST instead of PUT")

    return FHIRResource(
        file_path=file_path,
        resource_type=resource_type,
        resource_id=resource_id or "",
        data=data,
    )


def extract_bundle_entries(resources: List[FHIRResource]) -> List[FHIRResource]:
    """Extract individual resources from Bundle files (document/collection Bundles).

    Transaction Bundles are kept as-is since they should be POSTed whole.
    """
    result = []
    for resource in resources:
        if resource.resource_type != 'Bundle':
            result.append(resource)
            continue

        bundle_type = resource.data.get('type', '')

        # Transaction bundles are kept whole — they're POSTed to the server
        if bundle_type == 'transaction':
            result.append(resource)
            continue

        # For document/collection bundles, extract individual entries
        entries = resource.data.get('entry', [])
        if not entries:
            result.append(resource)
            continue

        extracted = 0
        for entry in entries:
            entry_resource = entry.get('resource')
            if not entry_resource or not entry_resource.get('resourceType'):
                continue
            entry_type = entry_resource['resourceType']
            entry_id = entry_resource.get('id', '')
            result.append(FHIRResource(
                file_path=resource.file_path,
                resource_type=entry_type,
                resource_id=entry_id,
                data=entry_resource,
            ))
            extracted += 1

        if extracted > 0:
            print(f"  Extracted {extracted} resources from Bundle {resource.file_path.name} (type={bundle_type})")
        else:
            # No extractable entries, keep the bundle as-is
            result.append(resource)

    return result


def deduplicate_resources(resources: List[FHIRResource]) -> List[FHIRResource]:
    """Remove duplicate resources by {ResourceType}/{id} key. Keeps first occurrence."""
    seen: Dict[str, FHIRResource] = {}
    duplicates = 0
    for resource in resources:
        if not resource.key:
            # Resources without id can't be deduped
            seen[f"_no_id_{id(resource)}"] = resource
            continue
        if resource.key in seen:
            duplicates += 1
            continue
        seen[resource.key] = resource

    if duplicates > 0:
        print(f"  Removed {duplicates} duplicate resources")

    return list(seen.values())


# ---------------------------------------------------------------------------
# Reference-based dependency sorting (topological sort)
# ---------------------------------------------------------------------------

def find_references(data, refs: Set[str] = None) -> Set[str]:
    """Recursively find all FHIR reference strings in a resource."""
    if refs is None:
        refs = set()

    if isinstance(data, dict):
        if 'reference' in data:
            ref = data['reference']
            if isinstance(ref, str) and '/' in ref and not ref.startswith(('urn:', 'http:', 'https:')):
                refs.add(ref)
        for value in data.values():
            find_references(value, refs)
    elif isinstance(data, list):
        for item in data:
            find_references(item, refs)

    return refs


def topological_sort_resources(resources: List[FHIRResource]) -> List[FHIRResource]:
    """Sort resources by dependency order using topological sort (Kahn's algorithm).

    Builds a dependency graph from FHIR reference fields, then sorts so that
    referenced resources are uploaded before resources that reference them.
    Falls back to type-level ordering for resources with no reference relationships.
    """
    # Build key -> resource map
    resource_map: Dict[str, FHIRResource] = {}
    for r in resources:
        if r.key:
            resource_map[r.key] = r

    # Build dependency graph: edges[A] = set of keys that A depends on (must be uploaded before A)
    edges: Dict[str, Set[str]] = defaultdict(set)
    in_degree: Dict[str, int] = {r.key: 0 for r in resources if r.key}

    for resource in resources:
        if not resource.key:
            continue
        refs = find_references(resource.data)
        for ref in refs:
            # Only track internal references (resources in our upload set)
            if ref in resource_map and ref != resource.key:
                edges[resource.key].add(ref)

    # Calculate in-degrees (how many resources depend on each resource)
    # Actually we need: in_degree[X] = number of dependencies X has (resources that must come before X)
    for key in in_degree:
        in_degree[key] = len(edges[key])

    # Kahn's algorithm
    def type_order_key(key: str) -> Tuple[int, str]:
        rtype = key.split('/')[0] if '/' in key else ''
        return (RESOURCE_TYPE_ORDER.get(rtype, DEFAULT_TYPE_ORDER), key)

    # Start with resources that have no dependencies
    queue = deque(sorted(
        [k for k, d in in_degree.items() if d == 0],
        key=type_order_key
    ))
    sorted_keys: List[str] = []

    while queue:
        current = queue.popleft()
        sorted_keys.append(current)

        # Find resources that depend on current and reduce their in-degree
        for key, deps in edges.items():
            if current in deps:
                deps.discard(current)
                in_degree[key] -= 1
                if in_degree[key] == 0:
                    # Insert in type-order to maintain stable sort within same dependency level
                    queue.append(key)
        # Re-sort queue to maintain type ordering
        queue = deque(sorted(queue, key=type_order_key))

    # Check for circular dependencies
    remaining = [k for k, d in in_degree.items() if d > 0]
    if remaining:
        print(f"  Warning: Circular dependencies detected among {len(remaining)} resources")
        print(f"  Involved: {', '.join(remaining[:10])}")
        # Add remaining resources at the end anyway
        sorted_keys.extend(sorted(remaining, key=type_order_key))

    # Build final sorted list
    sorted_resources: List[FHIRResource] = []
    for key in sorted_keys:
        if key in resource_map:
            sorted_resources.append(resource_map[key])

    # Add resources without keys (no id) at the end
    for r in resources:
        if not r.key:
            sorted_resources.append(r)

    return sorted_resources


# ---------------------------------------------------------------------------
# Base uploader
# ---------------------------------------------------------------------------

class BaseUploader(ABC):
    """Base class for FHIR uploaders with common batching and progress logic."""

    def __init__(self, fhir_url: str, dry_run: bool = False,
                 continue_on_error: bool = True, batch_size: int = 50):
        self.fhir_url = fhir_url.rstrip('/')
        self.dry_run = dry_run
        self.continue_on_error = continue_on_error
        self.batch_size = batch_size

    def upload_resources(self, resources: List[FHIRResource]) -> UploadSummary:
        """Upload all resources in batches with progress reporting."""
        summary = UploadSummary(total_files=len(resources))
        start_time = time.time()

        total_batches = (len(resources) + self.batch_size - 1) // self.batch_size

        for batch_idx in range(total_batches):
            batch_start = batch_idx * self.batch_size
            batch_end = min(batch_start + self.batch_size, len(resources))
            batch = resources[batch_start:batch_end]

            print(f"\nUploading: Batch {batch_idx + 1}/{total_batches} "
                  f"[{batch_start + 1}-{batch_end} of {len(resources)}]")

            if self.dry_run:
                for resource in batch:
                    print(f"  [DRY RUN] Would upload {resource.resource_type}/{resource.resource_id}")
                summary.skipped += len(batch)
                continue

            results = self._upload_batch(batch)

            batch_success = 0
            batch_fail = 0
            auth_failed = False

            for result in results:
                summary.results.append(result)
                if result.success:
                    summary.successful += 1
                    batch_success += 1
                else:
                    summary.failed += 1
                    batch_fail += 1
                    summary.errors.append(result)

                    if result.status_code in (401, 403):
                        print(f"  Authentication failed ({result.status_code}). Aborting.")
                        auth_failed = True
                        break

            print(f"  Batch {batch_idx + 1}/{total_batches} complete: "
                  f"{batch_success} succeeded, {batch_fail} failed")

            if auth_failed:
                break

            if batch_fail > 0 and not self.continue_on_error:
                print(f"  Stopping due to errors (continue_on_error=false)")
                break

        summary.duration_seconds = round(time.time() - start_time, 1)
        return summary

    @abstractmethod
    def _upload_batch(self, batch: List[FHIRResource]) -> List[UploadResult]:
        pass


# ---------------------------------------------------------------------------
# Direct FHIR uploader
# ---------------------------------------------------------------------------

class DirectFHIRUploader(BaseUploader):
    """Uploads FHIR resources directly to a FHIR server via REST API."""

    def __init__(self, fhir_url: str, auth_header: str,
                 upload_mode: str = 'individual',
                 conditional: bool = False, **kwargs):
        super().__init__(fhir_url, **kwargs)
        self.upload_mode = upload_mode
        self.conditional = conditional
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

    def upload_resources(self, resources: List[FHIRResource]) -> UploadSummary:
        """Override to support transaction mode which wraps all resources."""
        if self.upload_mode == 'transaction':
            return self._upload_as_transaction(resources)
        return super().upload_resources(resources)

    def _upload_as_transaction(self, resources: List[FHIRResource]) -> UploadSummary:
        """Wrap all resources into a single FHIR transaction Bundle and POST it."""
        summary = UploadSummary(total_files=len(resources))
        start_time = time.time()

        if self.dry_run:
            print(f"\n[DRY RUN] Would upload {len(resources)} resources as transaction Bundle")
            summary.skipped = len(resources)
            summary.duration_seconds = round(time.time() - start_time, 1)
            return summary

        print(f"\nBuilding transaction Bundle with {len(resources)} entries...")
        entries = []
        for resource in resources:
            entry = {
                "resource": resource.data,
                "request": {
                    "method": "PUT" if resource.resource_id else "POST",
                    "url": f"{resource.resource_type}/{resource.resource_id}" if resource.resource_id
                           else resource.resource_type,
                },
            }
            if resource.resource_id:
                entry["fullUrl"] = f"{self.fhir_url}/{resource.resource_type}/{resource.resource_id}"
            entries.append(entry)

        bundle = {
            "resourceType": "Bundle",
            "type": "transaction",
            "entry": entries,
        }

        print(f"POSTing transaction Bundle ({len(entries)} entries) to {self.fhir_url}...")
        try:
            response = self.session.post(self.fhir_url, json=bundle, timeout=300)
            success = response.status_code in (200, 201)

            if success:
                print(f"  Transaction succeeded: {response.status_code}")
                summary.successful = len(resources)
                for r in resources:
                    summary.results.append(UploadResult(
                        file_path=str(r.file_path.name),
                        resource_type=r.resource_type,
                        resource_id=r.resource_id,
                        success=True,
                        status_code=response.status_code,
                        method='POST (transaction)',
                    ))
            else:
                error_msg = response.text[:500] if response.text else f"HTTP {response.status_code}"
                print(f"  Transaction failed: {response.status_code}")
                print(f"  Error: {error_msg[:300]}")
                summary.failed = len(resources)
                for r in resources:
                    result = UploadResult(
                        file_path=str(r.file_path.name),
                        resource_type=r.resource_type,
                        resource_id=r.resource_id,
                        success=False,
                        status_code=response.status_code,
                        error_message=error_msg,
                        method='POST (transaction)',
                    )
                    summary.results.append(result)
                    summary.errors.append(result)

        except requests.exceptions.RequestException as e:
            error_msg = str(e)[:500]
            print(f"  Transaction request failed: {error_msg}")
            summary.failed = len(resources)
            for r in resources:
                result = UploadResult(
                    file_path=str(r.file_path.name),
                    resource_type=r.resource_type,
                    resource_id=r.resource_id,
                    success=False,
                    error_message=error_msg,
                    method='POST (transaction)',
                )
                summary.results.append(result)
                summary.errors.append(result)

        summary.duration_seconds = round(time.time() - start_time, 1)
        return summary

    def _upload_batch(self, batch: List[FHIRResource]) -> List[UploadResult]:
        results = []
        for resource in batch:
            result = self._upload_single(resource)
            results.append(result)

            status_str = f"{result.status_code}" if result.status_code else "error"
            indicator = "ok" if result.success else "FAIL"
            print(f"  {result.method} {resource.resource_type}/{resource.resource_id} "
                  f"... {status_str} {indicator}")

            if not result.success and result.error_message:
                print(f"       {result.error_message[:200]}")

            if result.status_code in (401, 403):
                break

        return results

    def _upload_single(self, resource: FHIRResource) -> UploadResult:
        """Upload a single resource via PUT (with optional conditional ETag check)."""
        try:
            bundle_type = resource.data.get('type', '') if resource.resource_type == 'Bundle' else ''

            if resource.resource_type == 'Bundle' and bundle_type == 'transaction':
                url = self.fhir_url
                method = 'POST'
                response = self.session.post(url, json=resource.data, timeout=120)
            elif resource.resource_id:
                url = f"{self.fhir_url}/{resource.resource_type}/{resource.resource_id}"
                method = 'PUT'

                # Conditional upload: GET first to check existence and get ETag
                extra_headers = {}
                if self.conditional:
                    extra_headers = self._get_conditional_headers(url)

                response = self.session.put(url, json=resource.data, headers=extra_headers, timeout=30)
            else:
                url = f"{self.fhir_url}/{resource.resource_type}"
                method = 'POST'
                response = self.session.post(url, json=resource.data, timeout=30)

            success = response.status_code in (200, 201)
            error_msg = None
            if not success:
                error_msg = response.text[:500] if response.text else f"HTTP {response.status_code}"

            return UploadResult(
                file_path=str(resource.file_path.name),
                resource_type=resource.resource_type,
                resource_id=resource.resource_id,
                success=success,
                status_code=response.status_code,
                error_message=error_msg,
                method=method,
            )

        except requests.exceptions.RequestException as e:
            return UploadResult(
                file_path=str(resource.file_path.name),
                resource_type=resource.resource_type,
                resource_id=resource.resource_id,
                success=False,
                error_message=str(e)[:500],
                method='PUT',
            )

    def _get_conditional_headers(self, url: str) -> dict:
        """GET a resource to check existence and retrieve ETag for conditional PUT."""
        try:
            resp = self.session.get(url, timeout=15)
            if resp.status_code == 200:
                etag = resp.headers.get('ETag')
                if etag:
                    return {'If-Match': etag}
            # 404 = doesn't exist yet, just do a normal PUT
        except requests.exceptions.RequestException:
            pass
        return {}


# ---------------------------------------------------------------------------
# FHIRFlare uploader
# ---------------------------------------------------------------------------

class FHIRFlareUploader(BaseUploader):
    """Uploads FHIR resources via FHIRFlare proxy service."""

    def __init__(self, fhirflare_url: str, api_key: str, fhir_url: str,
                 fhir_username: str, fhir_password: str,
                 upload_mode: str = 'individual', **kwargs):
        kwargs.setdefault('batch_size', 20)
        super().__init__(fhir_url, **kwargs)
        self.fhirflare_url = fhirflare_url.rstrip('/')
        self.api_key = api_key
        self.fhir_username = fhir_username
        self.fhir_password = fhir_password
        self.upload_mode = upload_mode

    def check_health(self) -> bool:
        """Check if FHIRFlare service is ready."""
        print(f"\nChecking FHIRFlare health at {self.fhirflare_url}...")
        max_attempts = 30
        for attempt in range(1, max_attempts + 1):
            for endpoint in [f"{self.fhirflare_url}/health", self.fhirflare_url]:
                try:
                    resp = requests.get(endpoint, timeout=10)
                    if resp.status_code == 200:
                        print(f"  FHIRFlare is ready!")
                        return True
                except requests.exceptions.RequestException:
                    pass

            print(f"  Waiting for FHIRFlare... (attempt {attempt}/{max_attempts})")
            time.sleep(10)

        print(f"  FHIRFlare not ready after {max_attempts} attempts")
        return False

    def _upload_batch(self, batch: List[FHIRResource]) -> List[UploadResult]:
        files = []
        file_handles = []
        try:
            for resource in batch:
                fh = open(resource.file_path, 'rb')
                file_handles.append(fh)
                files.append(('test_data_files', (resource.file_path.name, fh, 'application/json')))

            data = {
                'fhir_server_url': self.fhir_url,
                'auth_type': 'basic',
                'username': self.fhir_username,
                'password': self.fhir_password,
                'upload_mode': self.upload_mode,
                'error_handling': 'continue',
                'use_conditional_uploads': 'true',
            }

            headers = {
                'X-API-Key': self.api_key,
                'Accept': 'application/x-ndjson',
            }

            response = requests.post(
                f"{self.fhirflare_url}/api/upload-test-data",
                headers=headers,
                data=data,
                files=files,
                timeout=300,
            )

            # Log raw response for debugging
            print(f"  Response status: {response.status_code}")
            response_preview = response.text[:500] if response.text else "(empty)"
            print(f"  Response preview: {response_preview}")

            return self._parse_fhirflare_response(response, batch)

        except requests.exceptions.RequestException as e:
            error_msg = str(e)[:500]
            print(f"  Batch request failed: {error_msg}")
            return [
                UploadResult(
                    file_path=str(r.file_path.name),
                    resource_type=r.resource_type,
                    resource_id=r.resource_id,
                    success=False,
                    error_message=error_msg,
                    method='fhirflare',
                )
                for r in batch
            ]
        finally:
            for fh in file_handles:
                fh.close()

    def _parse_fhirflare_response(self, response, batch: List[FHIRResource]) -> List[UploadResult]:
        """Parse FHIRFlare NDJSON response.

        FHIRFlare returns lines like:
          {"type": "progress", "message": "..."}
          {"type": "success", "message": "..."}
          {"type": "error", "message": "..."}
          {"type": "complete", "data": {"status": "...", "resources_uploaded": N, ...}}
        """
        if response.status_code != 200:
            error_msg = response.text[:500] if response.text else f"HTTP {response.status_code}"
            return [
                UploadResult(
                    file_path=str(r.file_path.name),
                    resource_type=r.resource_type,
                    resource_id=r.resource_id,
                    success=False,
                    status_code=response.status_code,
                    error_message=error_msg,
                    method='fhirflare',
                )
                for r in batch
            ]

        # Parse NDJSON lines
        parsed_lines = []
        for line in response.text.strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            try:
                parsed_lines.append(json.loads(line))
            except json.JSONDecodeError:
                continue

        if parsed_lines:
            print(f"  NDJSON lines: {len(parsed_lines)}, first keys: {list(parsed_lines[0].keys())}")

        # Look for the "complete" summary line
        complete_data = None
        error_messages = []
        success_messages = []
        for line_data in parsed_lines:
            line_type = line_data.get('type', '')
            message = line_data.get('message', '')

            if line_type == 'complete':
                complete_data = line_data.get('data', {})
            elif line_type == 'error':
                error_messages.append(message)
            elif line_type == 'success':
                success_messages.append(message)

        results = []

        if complete_data:
            # Use the complete summary to determine overall result
            status = complete_data.get('status', 'failure')
            uploaded = complete_data.get('resources_uploaded', 0)
            error_count = complete_data.get('error_count', 0)
            errors_list = complete_data.get('errors', [])

            print(f"  FHIRFlare result: status={status}, uploaded={uploaded}, errors={error_count}")

            if status in ('success', 'partial'):
                # Mark resources as successful up to the uploaded count
                for i, resource in enumerate(batch):
                    is_success = i < uploaded or (status == 'success')
                    error_msg = None
                    if not is_success and i < len(errors_list):
                        error_msg = str(errors_list[i])[:300]
                    elif not is_success and error_messages:
                        error_msg = '; '.join(error_messages)[:300]

                    results.append(UploadResult(
                        file_path=str(resource.file_path.name),
                        resource_type=resource.resource_type,
                        resource_id=resource.resource_id,
                        success=is_success,
                        status_code=200 if is_success else None,
                        error_message=error_msg,
                        method='fhirflare',
                    ))
            else:
                # Complete failure
                combined_errors = '; '.join(error_messages)[:500] if error_messages else complete_data.get('message', 'Upload failed')
                for resource in batch:
                    results.append(UploadResult(
                        file_path=str(resource.file_path.name),
                        resource_type=resource.resource_type,
                        resource_id=resource.resource_id,
                        success=False,
                        error_message=combined_errors,
                        method='fhirflare',
                    ))
        else:
            # No complete line found — fall back to counting success/error messages
            if error_messages and not success_messages:
                combined = '; '.join(error_messages)[:500]
                for resource in batch:
                    results.append(UploadResult(
                        file_path=str(resource.file_path.name),
                        resource_type=resource.resource_type,
                        resource_id=resource.resource_id,
                        success=False,
                        error_message=combined,
                        method='fhirflare',
                    ))
            elif not parsed_lines:
                # Empty response with 200 — assume success
                for resource in batch:
                    results.append(UploadResult(
                        file_path=str(resource.file_path.name),
                        resource_type=resource.resource_type,
                        resource_id=resource.resource_id,
                        success=True,
                        status_code=200,
                        method='fhirflare',
                    ))
            else:
                # Has parsed lines but no complete — dump raw for debugging
                raw_dump = json.dumps(parsed_lines[0])[:200]
                print(f"  Warning: Could not interpret FHIRFlare response, first line: {raw_dump}")
                for resource in batch:
                    results.append(UploadResult(
                        file_path=str(resource.file_path.name),
                        resource_type=resource.resource_type,
                        resource_id=resource.resource_id,
                        success=False,
                        error_message=f"Could not parse FHIRFlare response: {raw_dump}",
                        method='fhirflare',
                    ))

        for result in results:
            indicator = "ok" if result.success else "FAIL"
            print(f"  {result.resource_type}/{result.resource_id} ... {indicator}")
            if not result.success and result.error_message:
                print(f"       {result.error_message[:200]}")

        return results


# ---------------------------------------------------------------------------
# Summary generation
# ---------------------------------------------------------------------------

def generate_summary_markdown(summary: UploadSummary, method: str, fhir_url: str) -> str:
    """Generate GitHub Actions step summary as markdown."""
    status_label = "Success" if summary.failed == 0 else "Completed with errors"
    if summary.skipped > 0:
        status_label = "Dry Run"

    lines = [
        "## FHIR Test Data Load Results",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Status | {status_label} |",
        f"| Method | {method} |",
        f"| Target | `{fhir_url}` |",
        f"| Total Files | {summary.total_files} |",
        f"| Succeeded | {summary.successful} |",
        f"| Failed | {summary.failed} |",
        f"| Skipped (dry run) | {summary.skipped} |",
        f"| Duration | {summary.duration_seconds}s |",
        "",
    ]

    # Resource type breakdown
    type_counts: Dict[str, Dict[str, int]] = defaultdict(lambda: {'total': 0, 'ok': 0, 'fail': 0})
    for result in summary.results:
        type_counts[result.resource_type]['total'] += 1
        if result.success:
            type_counts[result.resource_type]['ok'] += 1
        else:
            type_counts[result.resource_type]['fail'] += 1

    if type_counts:
        lines.extend([
            "### Resource Type Breakdown",
            "",
            "| Resource Type | Total | Succeeded | Failed |",
            "|---------------|-------|-----------|--------|",
        ])
        for rtype in sorted(type_counts.keys()):
            counts = type_counts[rtype]
            lines.append(f"| {rtype} | {counts['total']} | {counts['ok']} | {counts['fail']} |")
        lines.append("")

    if summary.errors:
        lines.extend([
            "<details>",
            f"<summary>{summary.failed} failures (click to expand)</summary>",
            "",
            "| File | Resource | Status | Error |",
            "|------|----------|--------|-------|",
        ])
        for err in summary.errors:
            error_text = (err.error_message or "Unknown error")[:100].replace('|', '\\|').replace('\n', ' ')
            lines.append(
                f"| {err.file_path} | {err.resource_type}/{err.resource_id} "
                f"| {err.status_code or 'N/A'} | {error_text} |"
            )
        lines.extend(["", "</details>", ""])

    return "\n".join(lines)


def generate_summary_json(summary: UploadSummary, method: str, fhir_url: str) -> str:
    """Generate JSON summary for machine consumption."""
    if summary.failed == 0 and summary.skipped == 0:
        status = "success"
    elif summary.skipped > 0:
        status = "dry_run"
    else:
        status = "completed_with_errors"

    data = {
        "status": status,
        "total": summary.total_files,
        "succeeded": summary.successful,
        "failed": summary.failed,
        "skipped": summary.skipped,
        "duration_seconds": summary.duration_seconds,
        "method": method,
        "target_url": fhir_url,
        "errors": [
            {
                "file": e.file_path,
                "resource_type": e.resource_type,
                "resource_id": e.resource_id,
                "status_code": e.status_code,
                "error": (e.error_message or "")[:200],
            }
            for e in summary.errors
        ],
    }
    return json.dumps(data, indent=2)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Load FHIR test data to a FHIR server',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument('--method', choices=['direct', 'fhirflare'], required=True,
                        help='Upload method: direct to FHIR server or via FHIRFlare proxy')
    parser.add_argument('--fhir-url', required=True,
                        help='Target FHIR server base URL')
    parser.add_argument('--auth-header', default=os.getenv('FHIR_AUTH_HEADER'),
                        help='Base64 basic auth header (direct method, default: FHIR_AUTH_HEADER env)')
    parser.add_argument('--fhirflare-url', default=os.getenv('FHIRFLARE_URL'),
                        help='FHIRFlare base URL (fhirflare method, default: FHIRFLARE_URL env)')
    parser.add_argument('--fhirflare-api-key', default=os.getenv('FHIRFLARE_API_KEY'),
                        help='FHIRFlare API key (fhirflare method, default: FHIRFLARE_API_KEY env)')
    parser.add_argument('--fhir-username', default=os.getenv('FHIR_USERNAME'),
                        help='FHIR username (fhirflare method, default: FHIR_USERNAME env)')
    parser.add_argument('--fhir-password', default=os.getenv('FHIR_PASSWORD'),
                        help='FHIR password (fhirflare method, default: FHIR_PASSWORD env)')
    parser.add_argument('--data-dir', type=Path, required=True,
                        help='Directory containing FHIR test data JSON files')
    parser.add_argument('--exclude-patterns', default='vendor-demonstrator',
                        help='Comma-separated directory names to exclude (default: vendor-demonstrator)')
    parser.add_argument('--upload-mode', choices=['individual', 'transaction'],
                        default='individual',
                        help='Upload mode: individual PUTs or single transaction Bundle (default: individual)')
    parser.add_argument('--conditional', action='store_true', default=False,
                        help='Use conditional uploads with ETag (direct method, adds GET per resource)')
    parser.add_argument('--no-extract-bundles', action='store_true', default=False,
                        help='Do not extract entries from document/collection Bundles')
    parser.add_argument('--batch-size', type=int, default=50,
                        help='Files per batch (default: 50)')
    parser.add_argument('--dry-run', action='store_true', default=False,
                        help='Parse and sort files but do not upload')
    parser.add_argument('--continue-on-error', action='store_true', default=True,
                        help='Continue uploading after errors (default: true)')
    parser.add_argument('--fail-on-error', action='store_true', default=False,
                        help='Stop on first error')
    parser.add_argument('--summary-file', type=Path, default=None,
                        help='Write JSON summary to this file')
    parser.add_argument('--github-step-summary', type=Path,
                        default=os.getenv('GITHUB_STEP_SUMMARY'),
                        help='Path to GitHub step summary file')

    args = parser.parse_args()

    # Validate method-specific arguments
    if args.method == 'direct' and not args.auth_header:
        parser.error('--auth-header (or FHIR_AUTH_HEADER env) required for direct method')
    if args.method == 'fhirflare':
        if not args.fhirflare_url:
            parser.error('--fhirflare-url (or FHIRFLARE_URL env) required for fhirflare method')
        if not args.fhirflare_api_key:
            parser.error('--fhirflare-api-key (or FHIRFLARE_API_KEY env) required for fhirflare method')

    continue_on_error = not args.fail_on_error
    exclude_patterns = [p.strip() for p in args.exclude_patterns.split(',') if p.strip()]

    # Print header
    print("=" * 80)
    print("FHIR Test Data Loader")
    print("=" * 80)
    print(f"Method:            {args.method}")
    print(f"Target:            {args.fhir_url}")
    print(f"Data dir:          {args.data_dir}")
    print(f"Upload mode:       {args.upload_mode}")
    print(f"Batch size:        {args.batch_size}")
    print(f"Conditional:       {args.conditional}")
    print(f"Extract bundles:   {not args.no_extract_bundles}")
    print(f"Exclude:           {', '.join(exclude_patterns)}")
    print(f"Dry run:           {args.dry_run}")
    print(f"Continue on error: {continue_on_error}")
    if args.method == 'fhirflare':
        print(f"FHIRFlare URL:     {args.fhirflare_url}")
    print("=" * 80)

    # Discover files
    print(f"\nDiscovering files in {args.data_dir}...")
    files = discover_files(args.data_dir, exclude_patterns)
    print(f"  Found {len(files)} JSON files")

    if not files:
        print("No JSON files found!")
        sys.exit(1)

    # Parse resources
    print(f"\nParsing resources...")
    resources = []
    parse_errors = 0
    for f in files:
        resource = parse_fhir_resource(f)
        if resource:
            resources.append(resource)
        else:
            parse_errors += 1

    print(f"  Parsed {len(resources)} valid FHIR resources ({parse_errors} parse errors)")

    # Extract Bundle entries (for direct method)
    if args.method == 'direct' and not args.no_extract_bundles:
        before = len(resources)
        resources = extract_bundle_entries(resources)
        if len(resources) != before:
            print(f"  After Bundle extraction: {len(resources)} resources (was {before})")

    # Deduplicate
    resources = deduplicate_resources(resources)

    # Count by type
    type_counts = defaultdict(int)
    for r in resources:
        type_counts[r.resource_type] += 1
    type_summary = ", ".join(f"{t}({c})" for t, c in sorted(type_counts.items(), key=lambda x: x[1], reverse=True))
    print(f"  Resource types: {type_summary}")

    # Sort by dependency (reference-based topological sort)
    print(f"\nSorting by dependency order (reference analysis)...")
    resources = topological_sort_resources(resources)
    order_preview = []
    seen_types = set()
    for r in resources:
        if r.resource_type not in seen_types:
            seen_types.add(r.resource_type)
            order_preview.append(r.resource_type)
    print(f"  Order: {' -> '.join(order_preview)}")

    # Create uploader
    if args.method == 'direct':
        uploader = DirectFHIRUploader(
            fhir_url=args.fhir_url,
            auth_header=args.auth_header,
            upload_mode=args.upload_mode,
            conditional=args.conditional,
            dry_run=args.dry_run,
            continue_on_error=continue_on_error,
            batch_size=args.batch_size,
        )
    else:
        uploader = FHIRFlareUploader(
            fhirflare_url=args.fhirflare_url,
            api_key=args.fhirflare_api_key,
            fhir_url=args.fhir_url,
            fhir_username=args.fhir_username or '',
            fhir_password=args.fhir_password or '',
            upload_mode=args.upload_mode,
            dry_run=args.dry_run,
            continue_on_error=continue_on_error,
            batch_size=args.batch_size,
        )

        if not args.dry_run and not uploader.check_health():
            print("FHIRFlare service is not available. Aborting.")
            sys.exit(1)

    # Upload
    print(f"\n{'=' * 80}")
    print(f"Starting upload of {len(resources)} resources...")
    print(f"{'=' * 80}")

    summary = uploader.upload_resources(resources)

    # Print summary
    print(f"\n{'=' * 80}")
    print("SUMMARY")
    print(f"{'=' * 80}")
    print(f"Total files:  {summary.total_files}")
    print(f"Succeeded:    {summary.successful}")
    print(f"Failed:       {summary.failed}")
    print(f"Skipped:      {summary.skipped}")
    print(f"Duration:     {summary.duration_seconds}s")

    if summary.errors:
        print(f"\nFailed resources:")
        for err in summary.errors:
            print(f"  - {err.file_path}: {err.status_code or 'N/A'} {err.error_message or ''}")

    if args.dry_run:
        print("\n[DRY RUN] No changes were made")
    elif summary.failed == 0:
        print("\nAll resources uploaded successfully!")
    else:
        print(f"\nCompleted with {summary.failed} errors")

    print(f"{'=' * 80}")

    # Write GitHub step summary
    if args.github_step_summary:
        try:
            md = generate_summary_markdown(summary, args.method, args.fhir_url)
            with open(args.github_step_summary, 'a') as f:
                f.write(md)
            print(f"\nStep summary written to {args.github_step_summary}")
        except OSError as e:
            print(f"\nWarning: Could not write step summary: {e}")

    # Write JSON summary
    if args.summary_file:
        try:
            json_summary = generate_summary_json(summary, args.method, args.fhir_url)
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
