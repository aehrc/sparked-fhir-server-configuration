#!/usr/bin/env python3
"""
Helper script to update package configurations in simplified-multinode.yaml

This script adds or removes package references from specific nodes in the
simplified-multinode.yaml configuration file.

Usage:
    # Add package to nodes
    python update_node_packages.py \
        --action add \
        --nodes aucore,hl7au \
        --package package-international-patient-summary-2.0.0.json

    # Remove package from nodes
    python update_node_packages.py \
        --action remove \
        --nodes aucore,hl7au \
        --package package-international-patient-summary-2.0.0.json

    # Preview changes without applying
    python update_node_packages.py \
        --action add \
        --nodes aucore,hl7au \
        --package package-international-patient-summary-2.0.0.json \
        --dry-run
"""

import argparse
import re
import sys
from pathlib import Path
from typing import List, Set

try:
    import yaml
except ImportError:
    print("Error: 'pyyaml' library is required. Install with: pip install pyyaml")
    sys.exit(1)


def parse_startup_specs(specs_string: str) -> List[str]:
    """Parse the classpath-based package specifications string"""
    if not specs_string:
        return []

    pattern = r'classpath:/config_seeding/(package-[^\s]+\.json)'
    matches = re.findall(pattern, specs_string)
    return matches


def build_startup_specs(packages: List[str]) -> str:
    """Build the classpath-based package specifications string"""
    if not packages:
        return ""

    classpath_refs = [f"classpath:/config_seeding/{pkg}" for pkg in packages]
    return " ".join(classpath_refs)


def update_node_package(
    config: dict,
    node_name: str,
    package_name: str,
    action: str
) -> tuple[bool, str]:
    """
    Update a single node's package configuration

    Returns: (changed, message)
    """
    if 'cdrNodes' not in config or node_name not in config['cdrNodes']:
        return False, f"Node '{node_name}' not found in configuration"

    node_config = config['cdrNodes'][node_name]

    # Navigate to persistence.config.package_registry.startup_installation_specs
    if 'modules' not in node_config:
        node_config['modules'] = {}

    if 'persistence' not in node_config['modules']:
        node_config['modules']['persistence'] = {}

    if 'config' not in node_config['modules']['persistence']:
        node_config['modules']['persistence']['config'] = {}

    persistence_config = node_config['modules']['persistence']['config']

    # Get current package list
    current_specs = persistence_config.get('package_registry.startup_installation_specs', '')
    current_packages = parse_startup_specs(current_specs)

    # Convert to set for easier manipulation
    package_set = set(current_packages)

    if action == 'add':
        if package_name in package_set:
            return False, f"Package '{package_name}' already configured on node '{node_name}'"
        package_set.add(package_name)
        message = f"Added '{package_name}' to node '{node_name}'"

    elif action == 'remove':
        if package_name not in package_set:
            return False, f"Package '{package_name}' not found on node '{node_name}'"
        package_set.remove(package_name)
        message = f"Removed '{package_name}' from node '{node_name}'"

    else:
        return False, f"Invalid action: {action}"

    # Update the configuration
    new_packages = sorted(package_set)  # Sort for consistency
    new_specs = build_startup_specs(new_packages)
    persistence_config['package_registry.startup_installation_specs'] = new_specs

    return True, message


def main():
    parser = argparse.ArgumentParser(
        description='Update package configurations in simplified-multinode.yaml',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    parser.add_argument(
        '--action',
        choices=['add', 'remove'],
        required=True,
        help='Action to perform: add or remove package'
    )

    parser.add_argument(
        '--nodes',
        required=True,
        help='Comma-separated list of node names to update'
    )

    parser.add_argument(
        '--package',
        required=True,
        help='Package filename (e.g., package-international-patient-summary-2.0.0.json)'
    )

    parser.add_argument(
        '--config-file',
        type=Path,
        default=Path('module-config/simplified-multinode.yaml'),
        help='Path to simplified-multinode.yaml (default: module-config/simplified-multinode.yaml)'
    )

    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without modifying the file'
    )

    args = parser.parse_args()

    # Validate config file exists
    if not args.config_file.exists():
        print(f"Error: Config file not found: {args.config_file}")
        sys.exit(1)

    # Load configuration
    print(f"Loading configuration from {args.config_file}...")
    with open(args.config_file, 'r') as f:
        config = yaml.safe_load(f)

    # Parse nodes
    nodes = [n.strip() for n in args.nodes.split(',')]

    print(f"\nAction: {args.action.upper()}")
    print(f"Package: {args.package}")
    print(f"Target nodes: {', '.join(nodes)}")
    print(f"Dry run: {args.dry_run}")
    print("\n" + "=" * 80)

    # Track changes
    changes_made = []
    errors = []

    # Update each node
    for node_name in nodes:
        changed, message = update_node_package(config, node_name, args.package, args.action)

        if changed:
            changes_made.append(message)
            print(f"✅ {message}")
        else:
            errors.append(message)
            print(f"⚠️  {message}")

    print("=" * 80)

    # Save changes if not dry-run and changes were made
    if changes_made and not args.dry_run:
        print(f"\nWriting updated configuration to {args.config_file}...")

        # Preserve YAML formatting as much as possible
        with open(args.config_file, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False, width=120)

        print(f"✅ Configuration updated successfully!")
        print(f"   {len(changes_made)} change(s) applied")

    elif changes_made and args.dry_run:
        print("\n🔍 DRY RUN MODE - No changes written to file")
        print(f"   {len(changes_made)} change(s) would be applied")
        print("\n   Remove --dry-run to apply changes")

    elif not changes_made:
        print("\n⚠️  No changes made")
        if errors:
            print(f"   {len(errors)} error(s) encountered")

    # Print summary
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"Changes: {len(changes_made)}")
    print(f"Errors: {len(errors)}")

    if errors and not changes_made:
        sys.exit(1)

    sys.exit(0)


if __name__ == '__main__':
    main()
