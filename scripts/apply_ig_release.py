#!/usr/bin/env python3
"""
Apply an IG release (add or version-bump) across all the config files the
SmileCDR deployment needs updated, as a single, testable operation.

This is the engine behind the `create-ig-pr` job in `.github/workflows/
issue-labeled.yml`. It replaces the previous set of inline shell/python steps
so the logic can be unit-tested locally rather than only exercised in CI.

It does four things atomically for one package:

  1. Chooses the package filename. For a version bump it reuses the superseded
     file's stem (e.g. package-aucore-2.0.0.json -> package-aucore-2.1.0.json)
     so the naming stays consistent and matched by package id, not by the
     issue's display name. For a brand new package it derives the name from the
     IG display name.
  2. Writes module-config/packages/<file>.json (including packageUrl when a
     custom URL is supplied).
  3. Updates simplified-multinode.yaml for each target node, replacing any
     existing version of the same package id in place (see
     update_node_packages.update_node_package_in_file).
  4. Cleans up any package file that is now referenced by no node: deletes the
     file and removes its entries from values-common.yaml and terraform/main.tf.
     Then registers the new file in those two files if not already present.

Usage:
    python scripts/apply_ig_release.py \
        --package-id hl7.fhir.au.core \
        --version 2.1.0-draft \
        --ig-name "AU Core" \
        --nodes aucore,hl7au,ereq \
        --install-mode STORE_AND_INSTALL \
        --fetch-dependencies false \
        --package-url ""            # optional; omit/empty to resolve from registry
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple

# Reuse the spec-parsing / in-place-replace primitives.
from update_node_packages import (
    parse_package_spec,
    read_package_id,
    update_node_package_in_file,
)

MAPPED_PATH = "/home/smile/smilecdr/classes/config_seeding"


def slugify(name: str) -> str:
    return re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', name.lower()))


def find_existing_file_for_id(packages_dir: Path, package_id: str) -> Optional[Tuple[str, str]]:
    """Return (filename, version) of an existing package file whose `name`
    matches package_id, or None. If several match, the highest version string
    is chosen deterministically."""
    matches = []
    for path in sorted(packages_dir.glob('package-*.json')):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if data.get('name') == package_id:
            matches.append((path.name, str(data.get('version', ''))))
    if not matches:
        return None
    return sorted(matches, key=lambda m: m[1])[-1]


def choose_filename(packages_dir: Path, package_id: str, version: str,
                    ig_name: str) -> Tuple[str, Optional[str]]:
    """Decide the package filename and report the superseded existing file.

    Returns (new_filename, existing_filename_or_None).
    """
    existing = find_existing_file_for_id(packages_dir, package_id)
    if existing is None:
        return f"package-{slugify(ig_name)}-{version}.json", None

    existing_file, existing_version = existing
    if existing_version == version:
        # Same version already present: reuse the file (settings refresh).
        return existing_file, existing_file

    # Reuse the stem, swapping the version. Strip a trailing "-<oldver>.json".
    suffix = f"-{existing_version}.json"
    stem = existing_file[:-len(suffix)] if existing_file.endswith(suffix) \
        else existing_file[:-len('.json')]
    return f"{stem}-{version}.json", existing_file


def write_package_file(packages_dir: Path, filename: str, package_id: str,
                       version: str, install_mode: str, fetch_deps: bool,
                       package_url: str) -> None:
    spec = {
        "name": package_id,
        "version": version,
        "installMode": install_mode,
        "fetchDependencies": fetch_deps,
    }
    if package_url:
        spec["packageUrl"] = package_url
    (packages_dir / filename).write_text(json.dumps(spec, indent=2) + "\n")


def remove_mapped_file(values_content: str, filename: str) -> str:
    pattern = re.compile(
        rf'\n[ \t]*{re.escape(filename)}:\n[ \t]*path:[ \t]*{re.escape(MAPPED_PATH)}[ \t]*'
    )
    return pattern.sub('', values_content)


def add_mapped_file(values_content: str, filename: str) -> str:
    if re.search(rf'\n[ \t]*{re.escape(filename)}:\n', values_content):
        return values_content  # already present
    lines = values_content.split('\n')
    in_mapped = False
    last_path_idx = -1
    for i, line in enumerate(lines):
        if line.startswith('mappedFiles:'):
            in_mapped = True
            continue
        if in_mapped and line and not line.startswith(' ') and not line.startswith('\t'):
            break
        if in_mapped and line.strip() == f'path: {MAPPED_PATH}':
            last_path_idx = i
    if last_path_idx < 0:
        raise RuntimeError("Could not locate mappedFiles insertion point")
    lines.insert(last_path_idx + 1, f'    path: {MAPPED_PATH}')
    lines.insert(last_path_idx + 1, f'  {filename}:')
    return '\n'.join(lines)


def remove_tf_block(tf_content: str, filename: str) -> str:
    esc = re.escape(filename)
    pattern = re.compile(
        rf'\n[ \t]*\{{\n'
        rf'[ \t]*name[ \t]*=[ \t]*"{esc}"\n'
        rf'[ \t]*location[ \t]*=[ \t]*"classes/config_seeding"\n'
        rf'[ \t]*data[ \t]*=[ \t]*file\("\.\./module-config/packages/{esc}"\)\n'
        rf'[ \t]*\}},'
    )
    return pattern.sub('', tf_content)


def add_tf_block(tf_content: str, filename: str) -> str:
    if re.search(rf'name[ \t]*=[ \t]*"{re.escape(filename)}"', tf_content):
        return tf_content  # already present
    block = (
        "    {\n"
        f'      name     = "{filename}"\n'
        '      location = "classes/config_seeding"\n'
        f'      data     = file("../module-config/packages/{filename}")\n'
        "    },\n"
    )
    # Insert before the "# Users configuration" trailing comment inside the list.
    anchor = re.search(r'\n[ \t]*# Users configuration', tf_content)
    if anchor:
        idx = anchor.start() + 1  # keep the leading newline
        return tf_content[:idx] + block + tf_content[idx:]
    # Fallback: insert before the closing bracket of helm_chart_mapped_files.
    anchor = re.search(r'\n[ \t]*\]\n', tf_content)
    if not anchor:
        raise RuntimeError("Could not locate terraform insertion point")
    idx = anchor.start() + 1
    return tf_content[:idx] + block + tf_content[idx:]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--package-id', required=True)
    p.add_argument('--version', required=True)
    p.add_argument('--ig-name', required=True, help='Display name (fallback for new-package filename)')
    p.add_argument('--nodes', required=True, help='Comma-separated node names')
    p.add_argument('--install-mode', default='STORE_ONLY',
                   choices=['STORE_ONLY', 'STORE_AND_INSTALL'])
    p.add_argument('--fetch-dependencies', default='false')
    p.add_argument('--package-url', default='')
    p.add_argument('--config-file', type=Path, default=Path('module-config/simplified-multinode.yaml'))
    p.add_argument('--values-file', type=Path, default=Path('module-config/values-common.yaml'))
    p.add_argument('--terraform-file', type=Path, default=Path('terraform/main.tf'))
    p.add_argument('--packages-dir', type=Path, default=Path('module-config/packages'))
    p.add_argument('--github-output', type=Path, default=None,
                   help='Optional path to write key=value outputs (e.g. $GITHUB_OUTPUT)')
    args = p.parse_args()

    fetch_deps = str(args.fetch_dependencies).strip().lower() in ('true', '1', 'yes')
    nodes = [n.strip() for n in args.nodes.split(',') if n.strip()]

    # 1. Choose filename (reuse superseded stem on a version bump).
    filename, _existing = choose_filename(args.packages_dir, args.package_id,
                                           args.version, args.ig_name)
    print(f"Package file: {filename}")

    # 2. Write the package JSON.
    write_package_file(args.packages_dir, filename, args.package_id, args.version,
                       args.install_mode, fetch_deps, args.package_url)
    print(f"Wrote {args.packages_dir / filename}")

    # 3. Update simplified-multinode.yaml for each node (replace-by-id).
    content = args.config_file.read_text()
    superseded: List[str] = []
    for node in nodes:
        changed, message, content, sup = update_node_package_in_file(
            content, node, filename, 'add', args.packages_dir)
        print(f"  {node}: {message}")
        if sup and sup not in superseded:
            superseded.append(sup)
    args.config_file.write_text(content)

    # 4a. Fully-orphaned files (no node references them any more): delete + purge refs.
    orphaned = [f for f in superseded if f"config_seeding/{f}" not in content]
    values_content = args.values_file.read_text()
    tf_content = args.terraform_file.read_text()
    for f in orphaned:
        (args.packages_dir / f).unlink(missing_ok=True)
        values_content = remove_mapped_file(values_content, f)
        tf_content = remove_tf_block(tf_content, f)
        print(f"  removed superseded file and refs: {f}")

    # 4b. Register the new file (skip if reused an existing filename already present).
    values_content = add_mapped_file(values_content, filename)
    tf_content = add_tf_block(tf_content, filename)
    args.values_file.write_text(values_content)
    args.terraform_file.write_text(tf_content)

    kept = [f for f in superseded if f not in orphaned]
    print(f"NEW_FILE={filename}")
    print(f"ORPHANED_FILES={','.join(orphaned)}")
    print(f"RETAINED_SUPERSEDED_FILES={','.join(kept)}")

    if args.github_output:
        with open(args.github_output, 'a') as fh:
            fh.write(f"package_file_name={filename}\n")
            fh.write(f"orphaned_files={','.join(orphaned)}\n")
            fh.write(f"retained_superseded_files={','.join(kept)}\n")

    return 0


if __name__ == '__main__':
    sys.exit(main())
