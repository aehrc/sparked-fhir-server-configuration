#!/usr/bin/env python3
"""
SmileCDR Package Synchronization Script

This script synchronizes FHIR IG packages across SmileCDR nodes.

Usage:
    # From GitHub Actions workflow
    python sync_packages.py --base-url https://smile.sparked-fhir.com --nodes aucore,hl7au --source config --dry-run

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
from typing import List, Dict, Optional

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

    def get_installed_packages(self, node_name: str) -> List[Dict]:
        """Get list of currently installed packages from a node"""
        url = f"{self.base_url}/{node_name}/package/npm/-/v1/search"

        print(f"\n📦 Fetching installed packages from {node_name}...")
        print(f"   URL: {url}")

        try:
            response = requests.get(url, headers=self.headers, timeout=30)
            response.raise_for_status()

            data = response.json()

            installed = []
            if 'objects' in data:
                for obj in data['objects']:
                    package = obj.get('package', {})
                    installed.append({
                        'name': package.get('name'),
                        'version': package.get('version')
                    })

            print(f"   Found {len(installed)} installed packages")
            for pkg in installed:
                print(f"     - {pkg['name']}@{pkg['version']}")

            return installed

        except requests.exceptions.RequestException as e:
            print(f"   ❌ Error fetching packages: {e}")
            return []

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
            print(f"      ❌ Error installing: {e}")
            if hasattr(e, 'response') and hasattr(e.response, 'text'):
                print(f"      Response: {e.response.text}")
            return False

    def sync_node(self, node_name: str, desired_packages: List[Dict], force_reinstall: bool = False, skip_uninstall: bool = False) -> bool:
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
        installed_packages = self.get_installed_packages(node_name)

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

            if is_installed and not force_reinstall:
                print(f"   ✓ Already installed, skipping")
                continue

            # Uninstall if exists (for force reinstall or version update)
            if is_installed and not skip_uninstall:
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

            # Install the package
            success = self.install_package(node_name, package)
            if not success and not self.dry_run:
                failed_operations.append(f"Install {package_key} on {node_name}")

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
        success = syncer.sync_node(node_name, desired_packages, args.force_reinstall, args.skip_uninstall)
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
