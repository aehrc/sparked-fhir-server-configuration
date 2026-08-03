#!/usr/bin/env python3
"""Diff Smile CDR runtime module config between the old cluster and sparkey.

Both servers answer on the same hostname (smile.sparked-fhir.com); since the
2026-08-03 cutover that name resolves to sparkey, and the old one is reached by
pinning the connection to its load balancer, the same trick
upgrade_smoke_tests.sh uses with --connect-to.

Worth re-running before the old deployment is destroyed: that is the point of no
return for comparing the two.

Read-only: GETs module config only.

Interpreting the output:

  - Modules only on OLD should be the ereq and hl7au nodes (20 of them). That is
    the intended decommission, not drift.
  - Empty-vs-absent differences are suppressed. The old server serialises unset
    options as "" while the new one omits them, which produced 137 false
    positives the first time this was run.
  - What remains is real. As at 2026-08-03 that was 3 differences, all
    intentional: declarative IG package seeding, and the SMART post-authorize
    script moving from an inline blob to a classpath file (verified byte
    identical against the repo copy).

This compares module CONFIG only. It does not compare loaded conformance
content, which is how a missing AU Base gender-identity SearchParameter went
unnoticed until it was checked separately. See docs/sparkey-cutover-runbook.md.
"""
import json
import subprocess
import sys
from typing import Any, Dict

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

HOST = "smile.sparked-fhir.com"
NODE = "aucore"
OLD_LB = "k8s-ingressn-ingressn-f807c43cbc-ec2e8c167651c4d6.elb.ap-southeast-2.amazonaws.com"


def admin_password() -> str:
    out = subprocess.check_output(
        ["aws", "secretsmanager", "get-secret-value",
         "--secret-id", "smilecdr-user-passwords",
         "--query", "SecretString", "--output", "text"],
        text=True,
    )
    return json.loads(out)["smilecdr-admin-password"]


def session(password: str, pin_to: str | None) -> requests.Session:
    s = requests.Session()
    s.auth = ("admin", password)
    retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[502, 503, 504])
    s.mount("https://", HTTPAdapter(max_retries=retry))
    if pin_to:
        # Resolve the hostname to the old LB while keeping SNI and Host intact.
        from urllib3.util import connection

        orig = connection.create_connection

        def patched(address, *args, **kwargs):
            host, port = address
            if host == HOST:
                return orig((pin_to, port), *args, **kwargs)
            return orig(address, *args, **kwargs)

        connection.create_connection = patched
    return s


def fetch_modules(s: requests.Session) -> Dict[str, Any]:
    """Return {f"{nodeId}/{moduleId}": module} across every node the server reports."""
    r = s.get(f"https://{HOST}/{NODE}/admin-json/module-config", timeout=30)
    r.raise_for_status()
    out: Dict[str, Any] = {}
    for node in r.json().get("nodes", []):
        nid = node.get("nodeId")
        for m in node.get("modules", []) or []:
            mid = m.get("moduleId")
            if mid:
                out[f"{nid}/{mid}"] = m
    return out


def normalise(mod: Dict[str, Any]) -> Dict[str, str]:
    """Flatten a module to {optionKey: value}, dropping runtime-only noise."""
    opts = {}
    for o in mod.get("options", []) or []:
        k = o.get("key")
        v = o.get("value")
        if k is not None:
            opts[k] = v
    return opts


def main() -> int:
    pw = admin_password()
    new = fetch_modules(session(pw, None))
    old = fetch_modules(session(pw, OLD_LB))

    print(f"modules on OLD: {len(old)}   modules on NEW: {len(new)}\n")

    only_old = sorted(set(old) - set(new))
    only_new = sorted(set(new) - set(old))
    if only_old:
        print(f"ONLY ON OLD ({len(only_old)}): {', '.join(only_old)}")
    if only_new:
        print(f"ONLY ON NEW ({len(only_new)}): {', '.join(only_new)}")
    if only_old or only_new:
        print()

    def empty(v: Any) -> bool:
        # The old server serialises unset options as "", the new one omits them.
        # That is a serialisation difference, not configuration drift.
        return v is None or v == ""

    drift = 0
    suppressed = 0
    for mid in sorted(set(old) & set(new)):
        o, n = normalise(old[mid]), normalise(new[mid])
        keys = sorted(set(o) | set(n))
        diffs = []
        for k in keys:
            ov, nv = o.get(k), n.get(k)
            if ov == nv:
                continue
            if empty(ov) and empty(nv):
                suppressed += 1
                continue
            diffs.append((k, ov, nv))
        if diffs:
            drift += len(diffs)
            print(f"## {mid}")
            for k, ov, nv in diffs:
                print(f"  {k}")
                print(f"    old: {ov!r}")
                print(f"    new: {nv!r}")
            print()

    print(f"total real option differences: {drift}")
    print(f"suppressed empty-vs-absent (serialisation only): {suppressed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
