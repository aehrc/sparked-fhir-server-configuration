#!/usr/bin/env python3
"""
Helper script to update package configurations in simplified-multinode.yaml

This script adds or removes package references from specific nodes in the
simplified-multinode.yaml configuration file while preserving formatting,
comments, and quotes.

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
from typing import List, Set, Tuple


def find_node_package_spec_line(content: str, node_name: str) -> Tuple[int, int, str]:
    """
    Find the line number and content of package_registry.startup_installation_specs
    for a specific node.

    Returns: (line_number, indent_spaces, current_value)
    """
    # Pattern to find the node section
    lines = content.split('\n')

    # Find the node section
    in_node = False
    in_persistence = False
    in_config = False
    node_indent = -1

    for i, line in enumerate(lines):
        # Check if we're entering the target node
        if re.match(rf'^\s+{re.escape(node_name)}:\s*$', line):
            in_node = True
            node_indent = len(line) - len(line.lstrip())
            continue

        # Check if we've left the node (new node at same indent level)
        if in_node and node_indent >= 0:
            current_indent = len(line) - len(line.lstrip())
            # If we find a line at same or less indent that looks like a key, we've left the node
            if current_indent <= node_indent and re.match(r'^\s+\w+:\s*', line):
                break

        if in_node:
            # Look for persistence module
            if 'persistence:' in line:
                in_persistence = True
                continue

            if in_persistence and 'config:' in line:
                in_config = True
                continue

            # Look for the package_registry line
            if in_config and 'package_registry.startup_installation_specs:' in line:
                # Extract the value
                match = re.match(r'^(\s+)package_registry\.startup_installation_specs:\s*(.*)$', line)
                if match:
                    indent = match.group(1)
                    value = match.group(2).strip()
                    # Remove quotes if present
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    elif value.startswith("'") and value.endswith("'"):
                        value = value[1:-1]
                    return i, len(indent), value

    return -1, 0, ""


def parse_package_spec(spec_value: str) -> List[str]:
    """Parse the classpath-based package specifications string"""
    if not spec_value:
        return []

    pattern = r'classpath:/config_seeding/(package-[^\s]+\.json)'
    matches = re.findall(pattern, spec_value)
    return matches


def build_package_spec(packages: List[str]) -> str:
    """Build the classpath-based package specifications string"""
    if not packages:
        return '""'

    classpath_refs = [f"classpath:/config_seeding/{pkg}" for pkg in packages]
    return '"' + ' '.join(classpath_refs) + '"'


def update_node_package_in_file(
    content: str,
    node_name: str,
    package_name: str,
    action: str
) -> Tuple[bool, str, str]:
    """
    Update a single node's package configuration in the file content

    Returns: (changed, message, new_content)
    """
    line_num, indent_spaces, current_value = find_node_package_spec_line(content, node_name)

    if line_num == -1:
        return False, f"Could not find package_registry.startup_installation_specs for node '{node_name}'", content

    # Parse current packages
    current_packages = parse_package_spec(current_value)
    package_set = set(current_packages)

    # Perform action
    if action == 'add':
        if package_name in package_set:
            return False, f"Package '{package_name}' already configured on node '{node_name}'", content
        package_set.add(package_name)
        message = f"Added '{package_name}' to node '{node_name}'"

    elif action == 'remove':
        if package_name not in package_set:
            return False, f"Package '{package_name}' not found on node '{node_name}'", content
        package_set.remove(package_name)
        message = f"Removed '{package_name}' from node '{node_name}'"

    else:
        return False, f"Invalid action: {action}", content

    # Build new package spec
    new_packages = sorted(package_set)
    new_spec_value = build_package_spec(new_packages)

    # Replace the line in content
    lines = content.split('\n')
    indent = ' ' * indent_spaces
    lines[line_num] = f"{indent}package_registry.startup_installation_specs: {new_spec_value}"

    new_content = '\n'.join(lines)
    return True, message, new_content


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
        content = f.read()

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
        changed, message, content = update_node_package_in_file(
            content, node_name, args.package, args.action
        )

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

        # Write the modified content back (preserves all formatting)
        with open(args.config_file, 'w') as f:
            f.write(content)

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
