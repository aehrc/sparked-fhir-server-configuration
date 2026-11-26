#!/usr/bin/env python3
"""Checks for the Smile CDR workload deployed by Argo CD (docs/design/smile-to-argo.md).

Every subcommand reads the Application itself (aehrc/sparked-argo
apps/smilecdr.yaml) for the chart, its version, the release name and the value
files in order, so what it checks is what Argo CD renders. `$values/` paths
resolve to this repository, `$deploy/` paths to the sparked-argo checkout.

  values   Merge Terraform's full value list (or a Helm release's values) and
           the Application's value files the way Helm does, and fail on any
           difference. The cross-check that sdh-deps still injects what
           apps/smilecdr/values-account.yaml says.
  render   Render the chart as Argo CD will and compare it object by object
           with a manifest (by default `helm get manifest` of the live release).
  dry-run  Server-side dry run (`kubectl diff`) of that render, carrying the
           annotation Argo CD adds, against the live objects. Fails on any
           change other than Argo CD's own metadata annotations.
  pairing  The sdh-deps module ref and helm_chart_version in terraform/main.tf
           name the same release, and (with --argo-repo) the Application's
           chart targetRevision matches them.

Examples:
  python3 scripts/smile_argo_check.py values --argo-repo ../sparked-argo \\
    --terraform-output <(cd terraform && terraform output -json smilecdr_helm_values)
  python3 scripts/smile_argo_check.py values --argo-repo ../sparked-argo \\
    --helm-values <(helm get values smilecdr -n smile --kube-context sparkey -o yaml)
  python3 scripts/smile_argo_check.py render --argo-repo ../sparked-argo \\
    --argocd-image quay.io/argoproj/argocd:v3.6.2
  python3 scripts/smile_argo_check.py dry-run --argo-repo ../sparked-argo \\
    --argocd-image quay.io/argoproj/argocd:v3.6.2

render and dry-run need helm (or docker, with --argocd-image to use the Helm
that Argo CD itself bundles) and, against the live cluster, read-only access.
Neither writes anything to the cluster: dry-run is `kubectl diff`, a
server-side dry run.
"""

import argparse
import difflib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
APP_FILE = "apps/smilecdr.yaml"

# What an Argo CD client-side apply adds to an adopted object, and nothing else.
ARGO_ANNOTATIONS = {
    "argocd.argoproj.io/tracking-id",
    "kubectl.kubernetes.io/last-applied-configuration",
}


# --- the Application --------------------------------------------------------------


def head_report(argo_repo: Path, require_main: bool) -> None:
    """Print which commits are being checked; with require_main, refuse anything but origin/main.

    Argo CD renders sparked-fhir-server-configuration at `main` and sparked-argo
    at `HEAD` when it syncs, not these checkouts. A check of a stale or feature
    checkout says nothing about what a sync applies.
    """
    bad = []
    for label, repo in (("sparked-fhir-server-configuration", ROOT), ("sparked-argo", argo_repo)):
        def git(*a):
            r = subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True)
            if r.returncode != 0:
                sys.exit(f"{label}: git {' '.join(a)} failed: {r.stderr.strip()}")
            return r.stdout.strip()
        head = git("rev-parse", "HEAD")
        dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
        # The remote's main, not the local origin/main ref, which may be stale.
        remote = git("ls-remote", "origin", "refs/heads/main").split()
        main = remote[0] if remote else ""
        if not head or not main:
            sys.exit(f"{label}: could not read HEAD or the remote main")
        print(f"{label}: HEAD {head[:12]}, remote main {main[:12]}{' (uncommitted changes)' if dirty else ''}")
        if head != main or dirty:
            bad.append(label)
    if bad and require_main:
        sys.exit(f"--require-main: {', '.join(bad)} not at a clean copy of the remote main; git fetch and check out origin/main first")
    if bad:
        print("note: not the remote main, so this checks a branch, not what a sync would apply")


def load_app(argo_repo: Path) -> dict:
    app = yaml.safe_load((argo_repo / APP_FILE).read_text())
    chart = next(s for s in app["spec"]["sources"] if s.get("chart"))
    helm = chart.get("helm", {})
    refs = {s["ref"]: s for s in app["spec"]["sources"] if s.get("ref")}
    roots = {}
    for name, src in refs.items():
        if src["repoURL"].rstrip("/").endswith("aehrc/sparked-fhir-server-configuration"):
            roots[name] = ROOT
        elif src["repoURL"].rstrip("/").endswith("aehrc/sparked-argo"):
            roots[name] = argo_repo
        else:
            sys.exit(f"unknown ref source {src['repoURL']}")
    files = []
    for vf in helm.get("valueFiles", []):
        m = re.match(r"^\$(\w+)/(.+)$", vf)
        if not m or m.group(1) not in roots:
            sys.exit(f"value file {vf} is not a $ref path this script knows")
        files.append(roots[m.group(1)] / m.group(2))
    if helm.get("values") or helm.get("valuesObject") or helm.get("parameters") or helm.get("fileParameters"):
        sys.exit("the Application sets inline values or parameters; teach this script about them first")
    return {
        "name": app["metadata"]["name"],
        "repo": chart["repoURL"],
        "chart": chart["chart"],
        "version": str(chart["targetRevision"]),
        "release": helm.get("releaseName", app["metadata"]["name"]),
        "namespace": app["spec"]["destination"]["namespace"],
        "skip_tests": bool(helm.get("skipTests")),
        "value_files": files,
    }


# --- values -------------------------------------------------------------------------


def merge(base, over):
    """Helm's coalescing for -f files: maps merge, null deletes, everything else replaces."""
    if not isinstance(base, dict) or not isinstance(over, dict):
        return over
    out = dict(base)
    for k, v in over.items():
        if v is None:
            out.pop(k, None)
        elif k in out:
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out


def set_dotted(values: dict, key: str, value):
    parts = re.split(r"(?<!\\)\.", key)
    cur = values
    for p in parts[:-1]:
        cur = cur.setdefault(p.replace("\\.", "."), {})
    cur[parts[-1].replace("\\.", ".")] = value


def flatten(d, prefix=""):
    if isinstance(d, dict) and d:
        out = {}
        for k, v in d.items():
            out.update(flatten(v, f"{prefix}.{k}"))
        return out
    return {prefix or ".": d}


def cmd_values(args) -> int:
    head_report(args.argo_repo, args.require_main)
    app = load_app(args.argo_repo)
    set_keys = set()
    argo = {}
    for f in app["value_files"]:
        argo = merge(argo, yaml.safe_load(f.read_text()) or {})

    if args.terraform_output:
        out = json.loads(Path(args.terraform_output).read_text())
        out = out.get("value", out)  # accept `terraform output -json` with or without a name
        theirs = {}
        for doc in out["values"]:
            theirs = merge(theirs, yaml.safe_load(doc) or {})
        for k, v in (out.get("set") or {}).items():
            set_dotted(theirs, k, v)
            set_keys.add("." + k.replace("\\.", "."))
        label = "terraform (sdh-deps helm_chart_values + set overrides)"
    else:
        theirs = yaml.safe_load(Path(args.helm_values).read_text()) or {}
        label = "helm release values"

    a, b = flatten(theirs), flatten(argo)
    bad = 0
    for k in sorted(set(a) | set(b)):
        x, y = a.get(k, "<absent>"), b.get(k, "<absent>")
        # Terraform passes --set values as strings and Helm parses them back to
        # numbers and booleans, so only those keys compare as strings.
        if x != y and not (k in set_keys and str(x) == str(y)):
            bad += 1
            print(f"{k}\n   {label}: {json.dumps(x)[:160]}\n   argo value files: {json.dumps(y)[:160]}")
    print(f"values compared: {len(set(a) | set(b))} leaves; differences: {bad}")
    return 1 if bad else 0


# --- render -------------------------------------------------------------------------


def helm_template(app: dict, args, workdir: Path) -> Path:
    """Render the chart with the Application's value files, as Argo CD does."""
    chart_dir = workdir / "chart"
    chart_dir.mkdir()
    vals_dir = workdir / "values"
    vals_dir.mkdir()
    rel_files = []
    for i, f in enumerate(app["value_files"]):
        dst = vals_dir / f"{i:02d}-{f.name}"
        shutil.copyfile(f, dst)
        rel_files.append(dst.relative_to(workdir).as_posix())

    if args.argocd_image:
        helm = ["docker", "run", "--rm", "-v", f"{workdir}:/w", "-w", "/w", "--entrypoint", "helm", args.argocd_image]
    else:
        helm = [args.helm]
    subprocess.run(
        helm + ["pull", app["chart"], "--repo", app["repo"], "--version", app["version"], "-d", "chart"],
        cwd=workdir, check=True, stdout=subprocess.DEVNULL,
    )
    tgz = next(chart_dir.glob("*.tgz")).relative_to(workdir).as_posix()
    cmd = helm + ["template", app["release"], tgz, "-n", app["namespace"]]
    if app["skip_tests"]:
        cmd.append("--skip-tests")
    for f in rel_files:
        cmd += ["-f", f]
    out = workdir / "render.yaml"
    with out.open("w") as fh:
        subprocess.run(cmd, cwd=workdir, check=True, stdout=fh)
    return out


def load_objects(path: Path) -> dict:
    objs = {}
    for d in yaml.safe_load_all(path.read_text()):
        if not d:
            continue
        api = d.get("apiVersion", "")
        group = api.split("/")[0] if "/" in api else ""
        m = d["metadata"]
        key = (group, d["kind"], m.get("namespace", ""), m["name"])
        if key in objs:
            sys.exit(f"duplicate object {key} in {path}")
        objs[key] = d
    return objs


def is_test_hook(d) -> bool:
    return (d.get("metadata", {}).get("annotations") or {}).get("helm.sh/hook", "").startswith("test")


def compare(live: dict, render: dict) -> int:
    bad = 0
    for k in sorted(set(live) - set(render)):
        if is_test_hook(live[k]):
            print("only in the manifest (Helm test hook, never installed):", k)
        else:
            print("ONLY IN THE MANIFEST:", k)
            bad += 1
    for k in sorted(set(render) - set(live)):
        print("ONLY IN THE RENDER:", k)
        bad += 1
    same = 0
    for k in sorted(set(live) & set(render)):
        a = json.dumps(live[k], sort_keys=True, indent=1).splitlines()
        b = json.dumps(render[k], sort_keys=True, indent=1).splitlines()
        if a == b:
            same += 1
            continue
        bad += 1
        print("DIFFERS:", k)
        for line in difflib.unified_diff(a, b, "manifest", "render", n=2, lineterm=""):
            print("   ", line[:200])
    print(f"identical objects: {same}; differences: {bad}")
    return bad


def cmd_render(args) -> int:
    head_report(args.argo_repo, args.require_main)
    app = load_app(args.argo_repo)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        render = helm_template(app, args, work)
        if args.manifest:
            manifest = Path(args.manifest)
        else:
            manifest = work / "live.yaml"
            with manifest.open("w") as fh:
                subprocess.run(
                    ["helm", "get", "manifest", app["release"], "-n", app["namespace"], "--kube-context", args.context],
                    check=True, stdout=fh,
                )
        if args.save_render:
            shutil.copyfile(render, args.save_render)
        print(f"chart {app['chart']} {app['version']}, release {app['release']}, {len(app['value_files'])} value files")
        return 1 if compare(load_objects(manifest), load_objects(render)) else 0


# --- dry-run ------------------------------------------------------------------------


def tracking_id(app_name: str, d: dict) -> str:
    api = d["apiVersion"]
    group = api.split("/")[0] if "/" in api else ""
    m = d["metadata"]
    return f"{app_name}:{group}/{d['kind']}:{m.get('namespace', '')}/{m['name']}"


def strip(d, path=()):
    """Drop what Argo CD's apply is allowed to change, and server bookkeeping."""
    m = d.get("metadata", {})
    ann = m.get("annotations") or {}
    for k in ARGO_ANNOTATIONS:
        ann.pop(k, None)
    if not ann:
        m.pop("annotations", None)
    # generation is server bookkeeping too: the Deployment registry bumps it on
    # any annotation change, not only a spec change ("annotations are copied
    # from deployments to their replica sets", kubernetes
    # pkg/registry/apps/deployment/strategy.go). The spec comparison below is
    # what decides whether the pods roll.
    for k in ("managedFields", "resourceVersion", "generation"):
        m.pop(k, None)
    return d


def cmd_extdiff(args) -> int:
    """KUBECTL_EXTERNAL_DIFF target: compare kubectl diff's LIVE and MERGED directories."""
    live_dir, merged_dir = Path(args.live), Path(args.merged)
    bad = 0
    for merged in sorted(merged_dir.iterdir()):
        live = live_dir / merged.name
        b = yaml.safe_load(merged.read_text()) or {}
        a = yaml.safe_load(live.read_text()) if live.exists() else {}
        a = a or {}
        added = sorted(set((b.get("metadata", {}).get("annotations") or {})) - set((a.get("metadata", {}).get("annotations") or {})))
        sa, sb = strip(json.loads(json.dumps(a))), strip(json.loads(json.dumps(b)))
        note = ""
        if (a.get("metadata", {}).get("generation")) != (b.get("metadata", {}).get("generation")):
            note = f"; generation {a['metadata'].get('generation')} to {b['metadata'].get('generation')} (annotation change)"
        if "template" in (a.get("spec") or {}):
            same_template = a["spec"]["template"] == b.get("spec", {}).get("template")
            note += "; spec.template identical" if same_template else "; SPEC.TEMPLATE CHANGES"
        if sa == sb:
            print(f"metadata only   {merged.name}: adds {', '.join(added) or 'nothing'}{note}")
            continue
        bad += 1
        print(f"CHANGES         {merged.name}")
        x = json.dumps(sa, sort_keys=True, indent=1).splitlines()
        y = json.dumps(sb, sort_keys=True, indent=1).splitlines()
        for line in difflib.unified_diff(x, y, "live", "after sync", n=2, lineterm=""):
            print("   ", line[:200])
    # kubectl diff reads exit 1 as "differences found"; >1 is an error.
    Path(os.environ["SMILE_ARGO_CHECK_RESULT"]).write_text(str(bad))
    return 1 if bad else 0


def cmd_dry_run(args) -> int:
    head_report(args.argo_repo, args.require_main)
    app = load_app(args.argo_repo)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        render = helm_template(app, args, work)
        docs = []
        for d in yaml.safe_load_all(render.read_text()):
            if not d or is_test_hook(d):
                continue
            d.setdefault("metadata", {}).setdefault("namespace", app["namespace"])
            ann = d["metadata"].setdefault("annotations", {}) or {}
            ann["argocd.argoproj.io/tracking-id"] = tracking_id(app["name"], d)
            d["metadata"]["annotations"] = ann
            docs.append(d)
        annotated = work / "annotated.yaml"
        annotated.write_text(yaml.safe_dump_all(docs, sort_keys=False))
        result = work / "result"
        env = dict(os.environ)
        # kubectl passes an external diff program only flag-style arguments, so
        # it gets a one-line wrapper that calls back into this script.
        wrapper = work / "extdiff.sh"
        wrapper.write_text(
            "#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(Path(__file__).resolve())) + ' _extdiff "$@"\n'
        )
        wrapper.chmod(0o755)
        env["KUBECTL_EXTERNAL_DIFF"] = str(wrapper)
        env["SMILE_ARGO_CHECK_RESULT"] = str(result)
        print(f"kubectl diff (server-side dry run) of {len(docs)} objects as Argo CD application {app['name']} would apply them:")
        proc = subprocess.run(["kubectl", "--context", args.context, "diff", "-f", str(annotated)], env=env)
        if proc.returncode > 1 or not result.exists():
            print(f"kubectl diff failed (exit {proc.returncode})", file=sys.stderr)
            return 2
        bad = int(result.read_text())
        print(f"objects with a change beyond Argo CD's metadata annotations: {bad}")
        return 1 if bad else 0


# --- pairing ------------------------------------------------------------------------


def terraform_versions() -> tuple:
    main_tf = (ROOT / "terraform" / "main.tf").read_text()
    ref = re.search(r'^\s*source\s*=\s*"git::https://gitlab\.com/smilecdr-public/smile-dh-helm-charts//src/main/terraform/sdh-deps\?ref=v([0-9.]+)"', main_tf, re.M)
    chart = re.search(r'^\s*helm_chart_version\s*=\s*"([0-9.]+)"', main_tf, re.M)
    if not ref or not chart:
        sys.exit("terraform/main.tf: could not find the sdh-deps module ref or helm_chart_version")
    return ref.group(1), chart.group(1)


def cmd_pairing(args) -> int:
    module, chart = terraform_versions()
    bad = 0
    print(f"terraform/main.tf: sdh-deps module v{module}, helm_chart_version {chart}")
    if module != chart:
        print("  the module ref and helm_chart_version differ: bump them together (docs/smile-deploy.md)")
        bad += 1
    if args.argo_repo:
        app = load_app(args.argo_repo)
        print(f"{APP_FILE}: chart {app['chart']} {app['version']}")
        if app["version"] != chart:
            print("  the Application's chart version differs from helm_chart_version in terraform/main.tf")
            bad += 1
    print("pairing OK" if not bad else "pairing BROKEN")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("values", help="Terraform's (or a release's) values vs the Application's value files")
    v.add_argument("--argo-repo", type=Path, required=True)
    g = v.add_mutually_exclusive_group(required=True)
    g.add_argument("--terraform-output", help="`terraform output -json smilecdr_helm_values`")
    g.add_argument("--helm-values", help="`helm get values smilecdr -n smile -o yaml`")
    v.add_argument("--require-main", action="store_true", help="fail unless both checkouts are a clean origin/main (the adoption window)")
    v.set_defaults(func=cmd_values)

    for name, func, helptext in (
        ("render", cmd_render, "render as Argo CD will and compare with a manifest"),
        ("dry-run", cmd_dry_run, "server-side dry run of the render against the live objects"),
    ):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--argo-repo", type=Path, required=True)
        p.add_argument("--context", default="sparkey", help="kube context (default sparkey)")
        p.add_argument("--helm", default="helm", help="helm binary when --argocd-image is not given")
        p.add_argument("--argocd-image", help="run the Helm bundled in this Argo CD image (docker), e.g. quay.io/argoproj/argocd:v3.6.2")
        p.add_argument("--require-main", action="store_true", help="fail unless both checkouts are a clean origin/main (the adoption window)")
        if name == "render":
            p.add_argument("--manifest", help="compare with this file instead of `helm get manifest` of the live release")
            p.add_argument("--save-render", help="also write the render here")
        p.set_defaults(func=func)

    p = sub.add_parser("pairing", help="module ref, helm_chart_version and the Application's chart version agree")
    p.add_argument("--argo-repo", type=Path)
    p.set_defaults(func=cmd_pairing)

    e = sub.add_parser("_extdiff", help=argparse.SUPPRESS)
    e.add_argument("live")
    e.add_argument("merged")
    e.set_defaults(func=cmd_extdiff)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
