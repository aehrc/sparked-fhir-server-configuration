#!/usr/bin/env python3
"""Update terminology server helm values files.

Adds, removes, or modifies package watches in the atomio-ig-feeder
helm values files under terminology-servers/.

Usage:
    python scripts/update_tx_helm_values.py \
        --action add-watch \
        --server tx-dev \
        --package-id hl7.fhir.au.ereq \
        --package-list-url https://hl7.org.au/fhir/ereq/package-list.json \
        --statuses "ballot,preview,draft,trial-use" \
        --version-mode latest

    python scripts/update_tx_helm_values.py \
        --action remove-watch \
        --server tx-hl7 \
        --package-id hl7.fhir.au.ereq

    python scripts/update_tx_helm_values.py \
        --action modify-watch \
        --server tx-dev \
        --package-id hl7.fhir.au.base \
        --version-mode pinned \
        --versions "6.0.0,5.0.0"
"""

import argparse
import os
import sys

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedSeq
from ruamel.yaml.scalarstring import SingleQuotedScalarString


SERVER_FILES = {
    "tx-dev": "terminology-servers/tx-dev-helm-values.yaml",
    "tx-hl7": "terminology-servers/tx-hl7-helm-values.yaml",
}

DEFAULT_FEEDS = {
    "tx-dev": "hl7au-dev",
    "tx-hl7": "reference",
}

VALID_STATUSES = {"ballot", "preview", "draft", "trial-use"}
VALID_VERSION_MODES = {"latest", "all", "pinned"}


def get_yaml():
    """Create a ruamel.yaml instance configured to preserve formatting."""
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 200  # avoid unnecessary line wrapping
    yaml.best_map_flow_style = True
    # Match the original file indentation:
    #   feeds:
    #     - feedName: ...       (offset=2, sequence=4)
    #       watches:
    #         - packageId: ...
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def find_feed(data, feed_name):
    """Find a feed by name in the feeds list."""
    for feed in data.get("feeds", []):
        if feed.get("feedName") == feed_name:
            return feed
    return None


def find_watch(feed, package_id):
    """Find a watch by packageId within a feed."""
    for i, watch in enumerate(feed.get("watches", [])):
        if watch.get("packageId") == package_id:
            return i, watch
    return -1, None


def make_flow_seq(items):
    """Create a YAML flow-style sequence (e.g. [ballot, preview])."""
    seq = CommentedSeq(items)
    seq.fa.set_flow_style()
    return seq


def add_watch(data, feed_name, package_id, package_list_url, display_name,
              statuses, version_mode, versions):
    """Add a new watch to a feed."""
    feed = find_feed(data, feed_name)
    if feed is None:
        print(f"Error: Feed '{feed_name}' not found in values file")
        sys.exit(1)

    idx, existing = find_watch(feed, package_id)
    if existing is not None:
        print(f"Error: Watch for '{package_id}' already exists in feed "
              f"'{feed_name}'. Use --action modify-watch to update it.")
        sys.exit(1)

    if not package_list_url:
        print("Error: --package-list-url is required when adding a watch")
        sys.exit(1)

    if not statuses:
        print("Error: --statuses is required when adding a watch")
        sys.exit(1)

    watch = {
        "packageId": package_id,
        "packageListUrl": package_list_url,
    }

    if display_name:
        watch["displayName"] = display_name

    watch["statuses"] = make_flow_seq(statuses)
    watch["versionMode"] = version_mode or "latest"

    if version_mode == "pinned" and versions:
        watch["versions"] = make_flow_seq(versions)

    feed["watches"].append(watch)
    print(f"Added watch for '{package_id}' to feed '{feed_name}'")


def remove_watch(data, feed_name, package_id):
    """Remove a watch from a feed by packageId."""
    feed = find_feed(data, feed_name)
    if feed is None:
        print(f"Error: Feed '{feed_name}' not found in values file")
        sys.exit(1)

    idx, existing = find_watch(feed, package_id)
    if existing is None:
        print(f"Error: Watch for '{package_id}' not found in feed "
              f"'{feed_name}'")
        sys.exit(1)

    del feed["watches"][idx]
    print(f"Removed watch for '{package_id}' from feed '{feed_name}'")


def modify_watch(data, feed_name, package_id, package_list_url, display_name,
                 statuses, version_mode, versions):
    """Modify an existing watch in a feed."""
    feed = find_feed(data, feed_name)
    if feed is None:
        print(f"Error: Feed '{feed_name}' not found in values file")
        sys.exit(1)

    idx, watch = find_watch(feed, package_id)
    if watch is None:
        print(f"Error: Watch for '{package_id}' not found in feed "
              f"'{feed_name}'. Use --action add-watch to create it.")
        sys.exit(1)

    if package_list_url:
        watch["packageListUrl"] = package_list_url

    if display_name:
        watch["displayName"] = display_name

    if statuses:
        watch["statuses"] = make_flow_seq(statuses)

    if version_mode:
        watch["versionMode"] = version_mode

    if version_mode == "pinned" and versions:
        watch["versions"] = make_flow_seq(versions)
    elif version_mode and version_mode != "pinned" and "versions" in watch:
        del watch["versions"]

    print(f"Modified watch for '{package_id}' in feed '{feed_name}'")


def process_server(server, action, feed_name, args, dry_run):
    """Process a single server's helm values file."""
    file_path = SERVER_FILES[server]

    # Resolve relative to repo root
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    full_path = os.path.join(repo_root, file_path)

    if not os.path.exists(full_path):
        print(f"Error: Values file not found: {full_path}")
        sys.exit(1)

    yaml = get_yaml()
    with open(full_path, "r") as f:
        data = yaml.load(f)

    # Use default feed name if not specified
    resolved_feed = feed_name or DEFAULT_FEEDS[server]

    if action == "add-watch":
        add_watch(data, resolved_feed, args.package_id,
                  args.package_list_url, args.display_name,
                  args.statuses_list, args.version_mode, args.versions_list)
    elif action == "remove-watch":
        remove_watch(data, resolved_feed, args.package_id)
    elif action == "modify-watch":
        modify_watch(data, resolved_feed, args.package_id,
                     args.package_list_url, args.display_name,
                     args.statuses_list, args.version_mode, args.versions_list)

    if dry_run:
        print(f"\n--- Dry run: {file_path} would be written as: ---")
        yaml.dump(data, sys.stdout)
        print("--- End dry run ---\n")
    else:
        with open(full_path, "w") as f:
            yaml.dump(data, f)
        print(f"Written: {file_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Update terminology server helm values files"
    )
    parser.add_argument(
        "--action",
        required=True,
        choices=["add-watch", "remove-watch", "modify-watch"],
        help="Action to perform",
    )
    parser.add_argument(
        "--server",
        required=True,
        help="Comma-separated target servers: tx-dev, tx-hl7",
    )
    parser.add_argument(
        "--package-id",
        required=True,
        help="FHIR package identifier (e.g. hl7.fhir.au.base)",
    )
    parser.add_argument(
        "--package-list-url",
        default=None,
        help="URL to the IG's package-list.json",
    )
    parser.add_argument(
        "--display-name",
        default=None,
        help="Display name for entry titles",
    )
    parser.add_argument(
        "--statuses",
        default=None,
        help="Comma-separated release statuses (ballot,preview,draft,trial-use)",
    )
    parser.add_argument(
        "--version-mode",
        default=None,
        choices=["latest", "all", "pinned"],
        help="Version selection mode",
    )
    parser.add_argument(
        "--versions",
        default=None,
        help="Comma-separated version list (for pinned mode)",
    )
    parser.add_argument(
        "--feed-name",
        default=None,
        help="Atomio feed name (defaults to server's primary feed)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing files",
    )

    args = parser.parse_args()

    # Parse comma-separated values
    servers = [s.strip() for s in args.server.split(",")]
    for s in servers:
        if s not in SERVER_FILES:
            print(f"Error: Unknown server '{s}'. Valid: {', '.join(SERVER_FILES)}")
            sys.exit(1)

    args.statuses_list = None
    if args.statuses:
        args.statuses_list = [s.strip() for s in args.statuses.split(",")]
        invalid = set(args.statuses_list) - VALID_STATUSES
        if invalid:
            print(f"Error: Invalid statuses: {invalid}. "
                  f"Valid: {VALID_STATUSES}")
            sys.exit(1)

    args.versions_list = None
    if args.versions:
        args.versions_list = [v.strip() for v in args.versions.split(",")]

    if args.version_mode == "pinned" and not args.versions_list:
        print("Error: --versions is required when --version-mode is pinned")
        sys.exit(1)

    for server in servers:
        print(f"\nProcessing {server}...")
        process_server(server, args.action, args.feed_name, args, args.dry_run)

    print("\nDone.")


if __name__ == "__main__":
    main()
