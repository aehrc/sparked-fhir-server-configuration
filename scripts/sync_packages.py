#!/usr/bin/env python3
"""
SmileCDR Package Synchronization Script

This script synchronizes FHIR IG packages across SmileCDR nodes.

Usage:
    # From GitHub Actions workflow
    python sync_packages.py --base-url https://smile.sparked-fhir.com --nodes aucore --source config --dry-run

    # Or sync all nodes from config
    python sync_packages.py --base-url https://smile.sparked-fhir.com --nodes all --source config

    # Or use custom packages
    python sync_packages.py --base-url https://smile.sparked-fhir.com --nodes aucore --source custom --packages '[{"name":"hl7.fhir.au.base","version":"6.0.0-ballot","installMode":"STORE_ONLY","fetchDependencies":true}]'

Environment Variables:
    SMILECDR_BASE_URL: Base URL for SmileCDR instance
    SMILECDR_AUTH_BASIC: Base64 encoded basic auth credentials
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import List, Dict, Optional, Tuple

try:
    import requests
except ImportError:
    print("Error: 'requests' library is required. Install with: pip install requests")
    sys.exit(1)

try:
    import yaml
except ImportError:
    print("Error: 'pyyaml' library is required. Install with: pip install pyyaml")
    sys.exit(1)


class SmileCDRPackageSync:
    """Manages package synchronization for SmileCDR nodes"""

    def __init__(self, base_url: str, auth_header: str, dry_run: bool = True):
        self.base_url = base_url.rstrip('/')
        self.dry_run = dry_run
        self.headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Basic {auth_header}'
        }

    def search_packages(self, node_name: str) -> Tuple[Optional[List[Dict]], Optional[str]]:
        """Read the node's npm search index without printing.

        Returns (packages, note). packages is None when the lookup failed (a
        request error, a body that is not JSON, or JSON that is not the npm
        search shape), so a caller can tell a failure from an empty registry.
        note is None when the response shows the list is complete, otherwise
        it says why the list may be incomplete. The npm search format pages
        with `from` and `size` query parameters rather than links, and whether
        Smile pages this endpoint at all has not been checked, so the script
        does not page; it compares the response's `total` with what came back.
        """
        url = f"{self.base_url}/{node_name}/package/npm/-/v1/search"
        try:
            response = requests.get(url, headers=self.headers, timeout=30)
            response.raise_for_status()
            data = response.json()
        except (requests.exceptions.RequestException, ValueError) as e:
            return None, f"search lookup failed: {e}"

        objects = data.get('objects') if isinstance(data, dict) else None
        if not isinstance(objects, list):
            return None, "search lookup failed: the response has no `objects` list"

        packages = []
        for obj in objects:
            package = obj.get('package') if isinstance(obj, dict) else None
            name = package.get('name') if isinstance(package, dict) else None
            version = package.get('version') if isinstance(package, dict) else None
            if not isinstance(name, str) or not isinstance(version, str):
                return None, "search lookup failed: an entry has no package name and version"
            packages.append({'name': name, 'version': version})

        total = data.get('total')
        if isinstance(total, int) and not isinstance(total, bool):
            if total > len(packages):
                return packages, f"possibly incomplete: the search returned {len(packages)} of {total}"
            return packages, None
        return packages, "possibly incomplete: the search response has no `total` to check against"

    def get_installed_packages(self, node_name: str) -> Tuple[Optional[List[Dict]], Optional[str]]:
        """Get the packages the node's search index lists (None if the lookup failed)"""
        url = f"{self.base_url}/{node_name}/package/npm/-/v1/search"

        print(f"\n📦 Fetching installed packages from {node_name}...")
        print(f"   URL: {url}")

        installed, note = self.search_packages(node_name)
        if installed is None:
            print(f"   ❌ {note}")
            return None, note

        print(f"   Found {len(installed)} installed packages")
        if note:
            print(f"   ⚠️  The list is {note}")
        for pkg in installed:
            print(f"     - {pkg['name']}@{pkg['version']}")

        return installed, note

    def uninstall_package(self, node_name: str, package_name: str, package_version: str) -> bool:
        """Uninstall a package from a node"""
        url = f"{self.base_url}/{node_name}/package/write/{package_name}/{package_version}"

        print(f"   🗑️  Uninstalling {package_name}@{package_version}")
        print(f"      URL: {url}")

        if self.dry_run:
            print(f"      [DRY RUN] Would uninstall package")
            return True

        try:
            response = requests.delete(url, headers=self.headers, timeout=30)
            response.raise_for_status()
            print(f"      ✅ Uninstalled successfully")
            return True
        except requests.exceptions.RequestException as e:
            print(f"      ⚠️  Error uninstalling: {e}")
            if hasattr(e, 'response') and hasattr(e.response, 'text'):
                print(f"      Response: {e.response.text}")
            # Continue anyway - package might not be installed
            return False

    def get_installed_versions(self, node_name: str, package_name: str) -> Optional[List[str]]:
        """Return every version of one package id stored on a node, or None if the lookup failed.

        Reads the npm packument rather than the search index. `/-/v1/search`
        reports a single object per package id, so it cannot see a version that
        is stored but not current, whereas SmileCDR keys the registry on
        (package id, version) and holds several versions at once.

        A 404 is read as "no version stored", as the npm registry API defines
        it; that Smile answers an unknown package id with 404 has not been
        checked. Any other error, a body that is not JSON, or JSON whose
        `versions` is not an object returns None, never an empty list, so a
        caller does not mistake a failed lookup for an empty registry.
        """
        url = f"{self.base_url}/{node_name}/package/npm/{package_name}"
        try:
            response = requests.get(url, headers=self.headers, timeout=30)
            if response.status_code == 404:
                return []
            response.raise_for_status()
            data = response.json()
        except (requests.exceptions.RequestException, ValueError):
            return None
        versions = data.get('versions') if isinstance(data, dict) else None
        if not isinstance(versions, dict):
            return None
        return sorted(versions.keys())

    def is_package_installed(self, node_name: str, package_name: str, package_version: str) -> bool:
        """Return True if a specific package@version is registered on a node.

        Used to confirm the real post-install state, since SmileCDR can return a
        500 or time out at the ingress while the install itself succeeds.

        Checks the packument first so a correctly stored non-current version is
        not reported as a failed install; falls back to the search index when
        the packument is unavailable.
        """
        versions = self.get_installed_versions(node_name, package_name)
        if versions:
            print(f"      Registry holds {package_name}: {', '.join(versions)}")
            return package_version in versions

        installed, _ = self.search_packages(node_name)
        return any(pkg['name'] == package_name and pkg['version'] == package_version
                   for pkg in installed or [])

    def install_package(self, node_name: str, package: Dict) -> bool:
        """Install a package on a node"""
        url = f"{self.base_url}/{node_name}/package/write/install/by-spec"

        package_name = package['name']
        package_version = package['version']
        install_mode = package.get('installMode', 'STORE_ONLY')
        fetch_deps = package.get('fetchDependencies', True)
        package_url = package.get('packageUrl')

        print(f"   📥 Installing {package_name}@{package_version}")
        print(f"      Mode: {install_mode}, Fetch deps: {fetch_deps}")

        payload = {
            'name': package_name,
            'version': package_version,
            'installMode': install_mode,
            'fetchDependencies': fetch_deps
        }

        if package_url:
            payload['packageUrl'] = package_url
            print(f"      Custom URL: {package_url}")

        if self.dry_run:
            print(f"      [DRY RUN] Would install with payload:")
            print(f"      {json.dumps(payload, indent=2)}")
            return True

        try:
            response = requests.put(url, headers=self.headers, json=payload, timeout=120)
            response.raise_for_status()
            print(f"      ✅ Installed successfully")
            return True
        except requests.exceptions.RequestException as e:
            response_text = getattr(getattr(e, 'response', None), 'text', '') or ''
            # SmileCDR may return a 500 when fetchDependencies re-inserts a
            # dependency package that already exists (e.g. duplicate key on
            # hl7.terminology.r4). The target package itself is still installed,
            # so confirm the real state before treating this as a failure.
            if self.is_package_installed(node_name, package_name, package_version):
                print(f"      ⚠️  Install returned an error, but "
                      f"{package_name}@{package_version} is registered on {node_name}; treating as success")
                if response_text:
                    print(f"      (server message: {response_text[:300]})")
                return True
            print(f"      ❌ Error installing: {e}")
            if response_text:
                print(f"      Response: {response_text}")
            return False

    def report_drift(self, node_name: str, desired_packages: List[Dict],
                     installed_packages: Optional[List[Dict]], search_note: Optional[str],
                     report_unlisted: bool) -> Dict[str, Optional[List[str]]]:
        """Print how the node's registry differs from the desired packages, both ways.

        Read-only (GET requests only, one packument per desired package id), so
        a dry run prints it too. For each desired package id it lists the
        desired version when the node lacks it (missing) and every other stored
        version (extra). The extras matter after an Argo CD roll: the seed
        install adds the new version but is not known to remove the superseded
        one, and the install loop below skips a package whose desired version
        is already stored, so it never removes an extra either. With
        report_unlisted (the whole seed config is the source), package ids
        stored on the node that the source does not list are printed as well;
        Smile fetches some of them as dependencies.

        A failed lookup is never reported as "none": an id whose packument
        lookup failed is named, with what could and could not be checked, and
        the block then does not say "No drift". Returns the stored versions per
        desired package id (None where the packument lookup failed) for the
        install loop.
        """
        desired_versions: Dict[str, List[str]] = {}
        for pkg in desired_packages:
            desired_versions.setdefault(pkg['name'], []).append(pkg['version'])

        stored_map: Dict[str, Optional[List[str]]] = {}
        missing = []
        extra = []
        fell_back = []
        unknown = []
        for name, versions in desired_versions.items():
            stored = self.get_installed_versions(node_name, name)
            current = [p['version'] for p in installed_packages or [] if p['name'] == name]
            if stored == [] and current:
                # A 404 for an id the search index lists is not a believable
                # "nothing stored", so treat it as a failed lookup.
                stored = None
            stored_map[name] = stored
            if stored is None:
                if installed_packages is None:
                    unknown.append(name)
                    continue
                # The search index shows only the current version of each
                # package id, so a stored non-current version reads as missing
                # and no extra version is visible.
                fell_back.append(name)
                stored = current
            missing += [f"{name}@{v}" for v in versions if v not in stored]
            extra += [f"{name}@{v}" for v in stored if v not in versions]

        print(f"\n🔎 Drift on {node_name} against the desired packages (before any change):")
        print(f"   Missing (desired version not stored): {', '.join(missing) if missing else 'none'}")
        print(f"   Extra (other version of a desired package still stored): {', '.join(extra) if extra else 'none'}")
        if fell_back:
            print(f"   ⚠️  Packument lookup failed, checked against the search index instead "
                  f"(current version only: Extra is not visible, and a stored non-current version "
                  f"reads as Missing): {', '.join(fell_back)}")
        if unknown:
            print(f"   ⚠️  Packument and search lookups both failed, Missing and Extra unknown: "
                  f"{', '.join(unknown)}")

        unlisted = []
        if report_unlisted:
            label = "   Not in the source (stored, package id not listed):"
            if installed_packages is None:
                print(f"{label} unknown ({search_note})")
            else:
                unlisted = sorted({f"{p['name']}@{p['version']}" for p in installed_packages
                                   if p['name'] not in desired_versions})
                listed = ', '.join(unlisted) if unlisted else 'none'
                print(f"{label} {listed}{f' ({search_note})' if search_note else ''}")

        lookups_failed = bool(fell_back or unknown) or (report_unlisted and installed_packages is None)
        if lookups_failed:
            print("   ⚠️  Drift not fully known: a lookup failed (see above), so this is not a clean result")
        elif not (missing or extra or unlisted):
            if report_unlisted and search_note:
                print("   No drift found, but the list of stored package ids may be incomplete (see above)")
            else:
                print("   No drift")

        return stored_map

    def sync_node(self, node_name: str, desired_packages: List[Dict], force_reinstall: bool = False,
                  skip_uninstall: bool = False, report_unlisted: bool = False) -> bool:
        """Sync packages for a single node"""
        print(f"\n{'=' * 80}")
        print(f"Processing node: {node_name}")
        print(f"{'=' * 80}")

        if not desired_packages:
            print(f"⚠️  No packages to install for node {node_name}")
            return True

        print(f"\nDesired packages ({len(desired_packages)}):")
        for pkg in desired_packages:
            print(f"  - {pkg['name']}@{pkg['version']}")

        # Get currently installed packages
        installed_packages, search_note = self.get_installed_packages(node_name)

        stored_map = self.report_drift(node_name, desired_packages, installed_packages, search_note,
                                       report_unlisted)

        if installed_packages is None:
            if not self.dry_run:
                # Without the search index the script cannot tell which version
                # is current, so it would install every package on top of what
                # is stored. Change nothing instead.
                print(f"\n❌ The search lookup failed, so the installed state of {node_name} is unknown; "
                      f"making no change on this node")
                return False
            print(f"\n⚠️  The search lookup failed; the plan below treats every package as not current")
            installed_packages = []

        # Create lookup map of installed packages
        installed_map = {
            f"{pkg['name']}@{pkg['version']}": pkg
            for pkg in installed_packages
        }

        # Process each desired package
        print(f"\n🔄 Synchronizing packages...")

        failed_operations = []

        for package in desired_packages:
            package_key = f"{package['name']}@{package['version']}"

            print(f"\n--- Processing {package_key} ---")

            is_installed = package_key in installed_map
            stored_versions = stored_map.get(package['name'])
            # Stored but not current: after a rollback revert the previous
            # version is still in the registry while the newer one is current.
            already_stored = (not is_installed and stored_versions is not None
                              and package['version'] in stored_versions)

            if is_installed and not force_reinstall:
                print(f"   ✓ Already installed, skipping")
                continue

            # Uninstall if exists (force reinstall only: a current version
            # without it was skipped above)
            if force_reinstall and (is_installed or already_stored) and not skip_uninstall:
                success = self.uninstall_package(node_name, package['name'], package['version'])
                if not success and not self.dry_run:
                    print(f"   ⚠️  Uninstall failed, but will try to reinstall anyway")
                    # Don't add to failed_operations - continue with install

            # Check if different version exists
            if not skip_uninstall:
                for installed_pkg in installed_packages:
                    if installed_pkg['name'] == package['name'] and installed_pkg['version'] != package['version']:
                        print(f"   ℹ️  Found different version: {installed_pkg['version']}")
                        success = self.uninstall_package(node_name, installed_pkg['name'], installed_pkg['version'])
                        if not success and not self.dry_run:
                            print(f"   ⚠️  Uninstall failed, but will try to reinstall anyway")
                            # Don't add to failed_operations - continue with install

            # A version already in the registry is not installed again: a PUT
            # would stack an install on the expunge that the uninstall above
            # just started (#92), and if it timed out at the ingress it would
            # read as a success only because the version was there before.
            if already_stored and not force_reinstall:
                print(f"   ✓ {package_key} is already stored, not reinstalling")
                continue

            if stored_versions is None and not self.dry_run:
                print(f"   ⚠️  The packument lookup for {package['name']} failed, so the script cannot tell "
                      f"whether {package['version']} is already stored; installing anyway")

            # Install the package
            success = self.install_package(node_name, package)
            if not success and not self.dry_run:
                failed_operations.append(f"Install {package_key} on {node_name}")

        if not self.dry_run:
            # Report every stored version, not just the current one, so a bump
            # that left an older version behind is visible in the run log.
            print(f"\n📋 Registry state for the packages just processed:")
            for name in dict.fromkeys(p['name'] for p in desired_packages):
                versions = self.get_installed_versions(node_name, name)
                if versions is None:
                    print(f"   {name}: (lookup failed)")
                else:
                    print(f"   {name}: {', '.join(versions) if versions else '(none)'}")

        print(f"\n{'=' * 80}")
        print(f"Completed processing node: {node_name}")
        print(f"{'=' * 80}")

        return len(failed_operations) == 0


def load_packages_from_config(config_path: Path) -> Dict[str, List[Dict]]:
    """Load packages from simplified-multinode.yaml"""
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)

    node_packages = {}

    if 'cdrNodes' in config:
        for node_name, node_config in config['cdrNodes'].items():
            if not node_config.get('enabled', False):
                continue

            packages = []

            # Extract from package_registry.startup_installation_specs
            if 'modules' in node_config and 'persistence' in node_config['modules']:
                persistence = node_config['modules']['persistence']
                if 'config' in persistence:
                    specs = persistence['config'].get('package_registry.startup_installation_specs', '')

                    # Parse the classpath references
                    pattern = r'classpath:/config_seeding/(package-[^\s]+\.json)'
                    matches = re.findall(pattern, specs)

                    for package_file in matches:
                        # Read the package JSON file
                        package_path = config_path.parent / 'packages' / package_file
                        try:
                            with open(package_path, 'r') as pf:
                                package_data = json.load(pf)
                                packages.append(package_data)
                        except FileNotFoundError:
                            print(f"Warning: Package file not found: {package_path}")

            node_packages[node_name] = packages

    return node_packages


def load_packages_from_dir(packages_dir: Path) -> List[Dict]:
    """Load all packages from the packages directory"""
    packages = []

    for package_file in packages_dir.glob('package-*.json'):
        try:
            with open(package_file, 'r') as f:
                package_data = json.load(f)
                packages.append(package_data)
        except Exception as e:
            print(f"Warning: Could not read {package_file}: {e}")

    return packages


def get_enabled_nodes(config_path: Path) -> List[str]:
    """Get list of enabled nodes from config"""
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)

    nodes = []
    if 'cdrNodes' in config:
        for node_name, node_config in config['cdrNodes'].items():
            if node_config.get('enabled', False):
                nodes.append(node_name)

    return nodes


def main():
    parser = argparse.ArgumentParser(
        description='Synchronize FHIR IG packages across SmileCDR nodes',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    parser.add_argument(
        '--base-url',
        default=os.getenv('SMILECDR_BASE_URL'),
        help='SmileCDR base URL (default: from SMILECDR_BASE_URL env var)'
    )

    parser.add_argument(
        '--auth',
        default=os.getenv('SMILECDR_AUTH_BASIC'),
        help='Base64 encoded basic auth credentials (default: from SMILECDR_AUTH_BASIC env var)'
    )

    parser.add_argument(
        '--nodes',
        required=True,
        help='Comma-separated list of node names or "all" for all enabled nodes'
    )

    parser.add_argument(
        '--source',
        choices=['config', 'packages-dir', 'custom'],
        default='config',
        help='Package source: config, packages-dir, or custom'
    )

    parser.add_argument(
        '--packages',
        help='Custom packages JSON (required if source=custom)'
    )

    parser.add_argument(
        '--config-dir',
        type=Path,
        default=Path('module-config'),
        help='Path to module-config directory'
    )

    parser.add_argument(
        '--dry-run',
        action='store_true',
        default=False,
        help='Show what would be done without making changes'
    )

    parser.add_argument(
        '--force-reinstall',
        action='store_true',
        default=False,
        help='Force reinstall all packages even if already installed'
    )

    parser.add_argument(
        '--skip-uninstall',
        action='store_true',
        default=False,
        help='Skip uninstall step and only run install (useful when DELETE fails)'
    )

    args = parser.parse_args()

    # Validate required arguments
    if not args.base_url:
        parser.error('--base-url is required (or set SMILECDR_BASE_URL env var)')

    if not args.auth:
        parser.error('--auth is required (or set SMILECDR_AUTH_BASIC env var)')

    if args.source == 'custom' and not args.packages:
        parser.error('--packages is required when source=custom')

    # Determine target nodes
    config_path = args.config_dir / 'simplified-multinode.yaml'

    if args.nodes == 'all':
        if not config_path.exists():
            print(f"Error: Config file not found: {config_path}")
            sys.exit(1)
        nodes = get_enabled_nodes(config_path)
    else:
        nodes = [n.strip() for n in args.nodes.split(',')]

    # Load package configurations
    if args.source == 'config':
        if not config_path.exists():
            print(f"Error: Config file not found: {config_path}")
            sys.exit(1)
        node_packages = load_packages_from_config(config_path)
        all_packages = None

    elif args.source == 'packages-dir':
        packages_dir = args.config_dir / 'packages'
        if not packages_dir.exists():
            print(f"Error: Packages directory not found: {packages_dir}")
            sys.exit(1)
        all_packages = load_packages_from_dir(packages_dir)
        node_packages = None

    else:  # custom
        all_packages = json.loads(args.packages)
        node_packages = None

    # Initialize sync manager
    syncer = SmileCDRPackageSync(
        base_url=args.base_url,
        auth_header=args.auth,
        dry_run=args.dry_run
    )

    # Print header
    print("=" * 80)
    print("SmileCDR Package Synchronization")
    print("=" * 80)
    print(f"Base URL: {args.base_url}")
    print(f"Target nodes: {', '.join(nodes)}")
    print(f"Package source: {args.source}")
    print(f"Dry run: {args.dry_run}")
    print(f"Force reinstall: {args.force_reinstall}")
    print(f"Skip uninstall: {args.skip_uninstall}")
    print("=" * 80)

    # Process each node
    all_success = True

    for node_name in nodes:
        # Get packages for this node
        if node_packages:
            desired_packages = node_packages.get(node_name, [])
        else:
            desired_packages = all_packages

        # Sync the node
        # Only the seed config is a node's whole desired list, so only then is
        # a stored package id it does not list worth reporting.
        success = syncer.sync_node(node_name, desired_packages, args.force_reinstall, args.skip_uninstall,
                                   report_unlisted=args.source == 'config')
        if not success:
            all_success = False

    # Print summary
    print(f"\n\n{'=' * 80}")
    print("SUMMARY")
    print(f"{'=' * 80}")

    if args.dry_run:
        print("✅ DRY RUN COMPLETED - No changes were made")
        print("   Remove --dry-run to apply changes")
    elif all_success:
        print("✅ ALL OPERATIONS COMPLETED SUCCESSFULLY")
    else:
        print("⚠️  COMPLETED WITH ERRORS - Check logs above for details")
        sys.exit(1)

    print(f"{'=' * 80}")


if __name__ == '__main__':
    main()
