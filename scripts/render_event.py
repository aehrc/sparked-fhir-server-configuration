#!/usr/bin/env python3
"""Render the participant guide and the operator checklist for a Sparked event.

Each event has one manifest, events/<yyyy-mm-place>.yaml, validated against
events/schema/event-manifest.schema.json. This script renders, from the
manifest plus the hand-written templates in events/templates/:

  - the participant guide (outputs.guide, under docs/participants/)
  - the operator checklist (outputs.checklist, under docs/operators/events/),
    which the operator pastes into a GitHub issue

Usage:
  python scripts/render_event.py                      # render every manifest
  python scripts/render_event.py events/X.yaml        # render one
  python scripts/render_event.py --check              # CI: fail if any output drifts
  python scripts/render_event.py --check-links events/X.yaml
                                                      # GET every https link in the guide
  EVENT_ACCESS_CODE=... python scripts/render_event.py \\
      --print-copy /tmp/guide-print.md events/X.yaml  # printable guide with the code

The access code is a venue secret: it only ever goes into a --print-copy file,
which must be written outside this repository.

Dependencies: PyYAML, jsonschema and tzdata (events/requirements.txt).
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

import jsonschema
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
EVENTS_DIR = REPO_ROOT / "events"
TEMPLATES_DIR = EVENTS_DIR / "templates"
SCHEMA_PATH = EVENTS_DIR / "schema" / "event-manifest.schema.json"

# Participant-facing text never uses these words (the guide makes no claim
# about anyone's results). Matched as whole words, case-insensitive.
BANNED_WORDS = re.compile(
    r"\b(conform\w*|certif\w*|pass|passes|passed|passing|verified)\b", re.IGNORECASE
)
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}")

# Every statement about sandboxes lives in templates/sandbox-<status>.md, one
# file per sandbox status, split into these slots by `<!-- slot: name -->`
# lines. The guide template uses them as {{ sandbox.slot.<name> }}, so a
# planned or cancelled sandbox never renders a sentence that assumes one.
# open is self-serve at sandbox.url with the access code; on-request is
# operator-issued from a pre-made batch, with no web address and no code.
SANDBOX_STATUSES = ("planned", "open", "on-request", "cancelled")
SANDBOX_SLOTS = ("summary", "services", "writes", "section", "auth")
SLOT_MARKER = re.compile(r"^<!-- slot: ([a-z_]+) -->[ \t]*$", re.MULTILINE)

# Karpenter expires a node this long after it was created (expireAfter 720h),
# so a node created in the window this far before the freeze expires inside it.
NODE_EXPIRY = dt.timedelta(days=30)


class ManifestError(Exception):
    """A manifest that fails the schema or a cross-field check."""


# --------------------------------------------------------------------------
# Loading and validation
# --------------------------------------------------------------------------


class _StringDateLoader(yaml.SafeLoader):
    """SafeLoader that keeps dates and timestamps as strings, so the schema
    sees exactly what is written in the file."""


_StringDateLoader.yaml_implicit_resolvers = {
    key: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def load_manifest(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        manifest = yaml.load(fh, Loader=_StringDateLoader)  # noqa: S506 (SafeLoader subclass)
    validate_manifest(manifest, path)
    return manifest


def _schema() -> dict:
    import json

    with SCHEMA_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def validate_manifest(manifest: dict, path: Path) -> None:
    validator = jsonschema.Draft202012Validator(_schema())
    errors = sorted(validator.iter_errors(manifest), key=lambda e: list(e.absolute_path))
    if errors:
        lines = [f"  {'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in errors]
        raise ManifestError(f"{path}: schema errors:\n" + "\n".join(lines))

    problems: list[str] = []
    if manifest["id"] != path.stem:
        problems.append(f"id {manifest['id']!r} must match the file name {path.stem!r}")

    tz = ZoneInfo(manifest["timezone"])
    start, end = _date(manifest["dates"]["start"]), _date(manifest["dates"]["end"])
    if end < start:
        problems.append("dates.end is before dates.start")
    for day in manifest["dates"]["programme"]:
        if not start <= _date(day["date"]) <= end:
            problems.append(f"programme date {day['date']} is outside the event dates")

    def checked_datetime(field: str, value: str) -> dt.datetime:
        moment = dt.datetime.fromisoformat(value)
        expected = moment.astimezone(tz).utcoffset()
        if moment.utcoffset() != expected:
            problems.append(
                f"{field} {value}: offset does not match {manifest['timezone']} on that date "
                f"(expected {_format_offset(expected)})"
            )
        return moment

    freeze_start = checked_datetime("freeze.start", manifest["freeze"]["start"])
    freeze_end = checked_datetime("freeze.end", manifest["freeze"]["end"])
    if not freeze_start.date() <= start <= end <= freeze_end.date():
        problems.append("the freeze window must cover the event dates")

    sandbox = manifest["sandbox"]
    opens = checked_datetime("sandbox.opens", sandbox["opens"])
    closes = checked_datetime("sandbox.creation_closes", sandbox["creation_closes"])
    if not opens < closes:
        problems.append("sandbox.opens must be before sandbox.creation_closes")
    if closes.date() < start:
        problems.append("sandbox.creation_closes is before the event starts")

    server_ids = [s["id"] for s in manifest["servers"]]
    if len(set(server_ids)) != len(server_ids):
        problems.append("server ids must be unique")
    for server in manifest["servers"]:
        defaults = {}
        for ig in server["igs"]:
            if ig.get("unversioned_default"):
                if ig["package"] in defaults:
                    problems.append(
                        f"server {server['id']}: two unversioned defaults for {ig['package']}"
                    )
                defaults[ig["package"]] = ig["version"]

    if sandbox["status"] == "open" and not manifest["sandbox"]["url"]:
        problems.append("an open sandbox needs a url")
    if manifest["status_page"]["public"] and not manifest["status_page"]["url"]:
        problems.append("a public status page needs a url")

    if problems:
        raise ManifestError(f"{path}:\n" + "\n".join(f"  {p}" for p in problems))


# --------------------------------------------------------------------------
# Formatting helpers
# --------------------------------------------------------------------------


def _date(value: str) -> dt.date:
    return dt.date.fromisoformat(value)


def _format_offset(offset: dt.timedelta | None) -> str:
    minutes = int((offset or dt.timedelta()).total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    return f"{sign}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"


def fmt_date(day: dt.date) -> str:
    return f"{day:%a} {day.day} {day:%b} {day.year}"


def fmt_datetime(moment: dt.datetime, tz: ZoneInfo) -> str:
    local = moment.astimezone(tz)
    return f"{fmt_date(local.date())}, {local:%H:%M} {local.tzname()}"


def fmt_date_range(start: dt.date, end: dt.date) -> str:
    if start == end:
        return fmt_date(start)
    if (start.year, start.month) == (end.year, end.month):
        return f"{start:%a} {start.day} to {end:%a} {end.day} {end:%b} {end.year}"
    return f"{fmt_date(start)} to {fmt_date(end)}"


def md_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def substitute(text: str, context: dict[str, str], source: str) -> str:
    missing: list[str] = []

    def repl(match: re.Match) -> str:
        key = match.group(1)
        if key not in context:
            missing.append(key)
            return match.group(0)
        return context[key]

    out = PLACEHOLDER.sub(repl, text)
    if missing:
        raise ManifestError(f"{source}: unknown placeholder(s): {', '.join(sorted(set(missing)))}")
    return out


def tidy(text: str) -> str:
    """Collapse runs of blank lines left by empty placeholders; end with one newline."""
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


# --------------------------------------------------------------------------
# Context: every value a template can use
# --------------------------------------------------------------------------


def sandbox_expiry(manifest: dict) -> dt.datetime:
    """When every event sandbox expires: midnight at the end of the last event
    day plus sandbox.expiry_days_after_event_end, in the event timezone. The
    sandbox service is configured with the same moment (event.sandboxes_expire);
    its hourly expire job applies it within about two hours, so the text says
    "overnight"."""
    tz = ZoneInfo(manifest["timezone"])
    day = _date(manifest["dates"]["end"]) + dt.timedelta(
        days=manifest["sandbox"]["expiry_days_after_event_end"] + 1
    )
    return dt.datetime.combine(day, dt.time(0), tzinfo=tz)


def fmt_overnight(moment: dt.datetime, tz: ZoneInfo) -> str:
    """The night that ends at midnight `moment`, e.g. "overnight from Thu 17
    to Fri 18 Dec 2026 (AEDT)"."""
    local = moment.astimezone(tz)
    morning = local.date()
    return (
        f"overnight from {fmt_date_range(morning - dt.timedelta(days=1), morning)} "
        f"({local.tzname()})"
    )


def build_context(manifest: dict, access_code: str | None = None) -> dict[str, str]:
    tz = ZoneInfo(manifest["timezone"])
    start, end = _date(manifest["dates"]["start"]), _date(manifest["dates"]["end"])
    freeze_start = dt.datetime.fromisoformat(manifest["freeze"]["start"])
    freeze_end = dt.datetime.fromisoformat(manifest["freeze"]["end"])
    sandbox = manifest["sandbox"]
    servers = {s["id"]: s for s in manifest["servers"]}
    inferno = manifest["inferno"]
    last_checked = max(
        [s["last_checked"] for s in manifest["servers"]]
        + [i["last_checked"] for i in manifest["known_issues"]]
        + [o["last_checked"] for o in manifest.get("not_on_sparked", [])]
    )

    ctx: dict[str, str] = {
        "event.id": manifest["id"],
        "event.name": manifest["name"],
        "event.short_name": manifest["short_name"],
        "event.venue": manifest["venue"],
        "event.event_page": manifest["event_page"],
        "event.dates": fmt_date_range(start, end),
        "freeze.start": fmt_datetime(freeze_start, tz),
        "freeze.end": fmt_datetime(freeze_end, tz),
        "freeze.window": f"{fmt_datetime(freeze_start, tz)} to {fmt_datetime(freeze_end, tz)}",
        # The freeze as the cron and duration the sparked-argo freeze blocks
        # render: Argo CD sync windows in the event timezone, Karpenter
        # budgets in UTC.
        "freeze.timezone": manifest["timezone"],
        "freeze.cron_local": _cron(freeze_start.astimezone(tz)),
        "freeze.cron_utc": _cron(freeze_start.astimezone(dt.timezone.utc)),
        "freeze.duration": f"{int((freeze_end - freeze_start).total_seconds() // 3600)}h",
        "freeze.node_expiry_window": (
            f"{fmt_datetime(freeze_start - NODE_EXPIRY, tz)} and "
            f"{fmt_datetime(freeze_end - NODE_EXPIRY, tz)}"
        ),
        "inferno.url": inferno["url"],
        "inferno.release.tracking": inferno["release"]["tracking"],
        "version_policy": " ".join(manifest["version_policy"].split()),
        "help.first_url": manifest["help"][0]["url"],
        "generated_note": (
            f"<!-- Generated from events/{manifest['id']}.yaml by scripts/render_event.py. "
            "Do not edit by hand: change the manifest or events/templates/, then re-render. -->\n\n"
            f"_Facts in this guide were last checked on {fmt_date(_date(last_checked))}._"
        ),
    }

    for sid, server in servers.items():
        ctx[f"server.{sid}.fhir_base"] = server["fhir_base"]
        ctx[f"server.{sid}.name"] = server["name"]
        for key, value in (server.get("smart") or {}).items():
            ctx[f"server.{sid}.smart.{key}"] = value

    # Sandbox
    ctx.update(
        {
            "sandbox.url": sandbox["url"],
            "sandbox.decision": sandbox["decision"],
            "sandbox.fallback": sandbox["fallback"],
            "sandbox.access_code_distribution": sandbox["access_code_distribution"],
            "sandbox.opens": fmt_datetime(dt.datetime.fromisoformat(sandbox["opens"]), tz),
            "sandbox.creation_closes": fmt_datetime(
                dt.datetime.fromisoformat(sandbox["creation_closes"]), tz
            ),
            "sandbox.expires": fmt_overnight(sandbox_expiry(manifest), tz),
            "sandbox.max_live": f"{sandbox['caps']['max_live']:,}",
            "sandbox.creates_per_ip_per_day": f"{sandbox['caps']['creates_per_ip_per_day']:,}",
            "sandbox.pre_event.creates_per_ip_per_day": (
                f"{sandbox['caps']['pre_event']['creates_per_ip_per_day']:,}"
            ),
            # The service's pre-event cap holds until 00:00 on the first event day.
            "sandbox.pre_event_until": fmt_date(start),
            "sandbox.resource_ceiling": f"{sandbox['caps']['resource_ceiling']:,}",
            "sandbox.access_code_line": (
                f"**Event access code: `{access_code}`**"
                if access_code
                else "The code is not in this guide."
            ),
        }
    )

    # Generated blocks
    ctx["programme"] = "Programme:\n\n" + "\n".join(
        f"- {fmt_date(_date(d['date']))}: {d['what']}" for d in manifest["dates"]["programme"]
    )
    ctx["servers_table"] = servers_table(manifest)
    ctx["version_map_table"] = version_map_table(manifest)
    ctx["validate_canonicals"] = validate_canonicals(manifest)
    ctx["validate.example"] = validate_example(manifest)
    ctx["terminology_list"] = "\n".join(
        f"- **{t['name']}**: `{t['url']}`. {t['note']}" for t in manifest["terminology"]
    )
    ctx["data_section"] = data_section(manifest)
    ctx["inferno_section"] = inferno_section(manifest)
    ctx["known_issues"] = known_issues(manifest)
    ctx["status_section"] = status_section(manifest)
    ctx["freeze_section"] = (
        f"From {ctx['freeze.window']}, the following stay as described here, "
        "except for a fix to an outage:\n\n"
        + "\n".join(f"- {item}" for item in manifest["freeze"]["covers"])
    )
    ctx["help_list"] = "\n".join(
        f"- [{h['name']}]({h['url']}): {h['use_for']}" for h in manifest["help"]
    )
    ctx["other_endpoints"] = other_endpoints(manifest)

    # Sandbox text: the slots of the partial for the current status, which
    # may include the shared partials (the self-serve plan, and the auth
    # recipes every status with a sandbox client shows).
    for key, name in (("sandbox_details", "sandbox-details.md"), ("sandbox_recipes", "sandbox-recipes.md")):
        ctx[key] = substitute(
            (TEMPLATES_DIR / name).read_text(encoding="utf-8"), ctx, name
        ).strip()
    for name, text in sandbox_slots(sandbox["status"]).items():
        ctx[f"sandbox.slot.{name}"] = substitute(
            text, ctx, f"sandbox-{sandbox['status']}.md ({name})"
        ).strip()
    return ctx


def sandbox_slots(status: str) -> dict[str, str]:
    """The named slots of templates/sandbox-<status>.md; each status file must
    define exactly SANDBOX_SLOTS."""
    name = f"sandbox-{status}.md"
    text = (TEMPLATES_DIR / name).read_text(encoding="utf-8")
    parts = SLOT_MARKER.split(text)
    if parts[0].strip():
        raise ManifestError(f"{name}: text before the first <!-- slot: ... --> line")
    slots: dict[str, str] = {}
    for slot, body in zip(parts[1::2], parts[2::2]):
        if slot in slots:
            raise ManifestError(f"{name}: slot {slot!r} appears twice")
        slots[slot] = body.strip()
    if set(slots) != set(SANDBOX_SLOTS):
        raise ManifestError(
            f"{name}: slots {sorted(slots)} must be exactly {sorted(SANDBOX_SLOTS)}"
        )
    return slots


def _cron(moment: dt.datetime) -> str:
    return f"{moment.minute} {moment.hour} {moment.day} {moment.month} *"


def other_endpoints(manifest: dict) -> str:
    entries = manifest.get("not_on_sparked", [])
    if not entries:
        return ""
    lines = ["**Not on the Sparked server.** Some event tracks use IGs that Sparked does not serve:", ""]
    for entry in entries:
        lines.append(
            f"- **{entry['title']} {entry['version']}**: `{entry['fhir_base']}` on the "
            f"{entry['server_name']}, checked {fmt_date(_date(entry['last_checked']))}. "
            f"{entry['note']}"
        )
    return "\n".join(lines)


def servers_table(manifest: dict) -> str:
    servers = manifest["servers"]
    header = "| | " + " | ".join(md_cell(s["name"]) for s in servers) + " |"
    sep = "|---|" + "---|" * len(servers)
    rows = [
        ("Run by", [s["run_by"] for s in servers]),
        ("FHIR base", [f"`{s['fhir_base']}`" for s in servers]),
        ("Access", [s["access"] for s in servers]),
        ("Software", [s.get("software", "") for s in servers]),
        (
            "SMART configuration",
            [f"`{s['smart']['configuration']}`" if s.get("smart") else "" for s in servers],
        ),
    ]
    lines = [header, sep]
    for label, cells in rows:
        if any(cells):
            lines.append(f"| {label} | " + " | ".join(md_cell(c) for c in cells) + " |")
    return "\n".join(lines)


def _split_not_served(entry: str) -> tuple[str, str]:
    title, _, version = entry.rpartition(" ")
    return title, version


def version_map_table(manifest: dict) -> str:
    servers = manifest["servers"]
    titles: list[str] = []
    for server in servers:
        for ig in server["igs"]:
            if ig["title"] not in titles:
                titles.append(ig["title"])
        for entry in server.get("not_served", []):
            title, _ = _split_not_served(entry)
            if title not in titles:
                titles.append(title)

    header = "| IG | " + " | ".join(md_cell(s["name"]) for s in servers) + " |"
    lines = [header, "|---|" + "---|" * len(servers)]
    for title in titles:
        cells = []
        for server in servers:
            parts = []
            for ig in server["igs"]:
                if ig["title"] != title:
                    continue
                label = f"**{ig['version']}** ({ig['status']}"
                label += ", used when no version is given)" if ig.get("unversioned_default") else ")"
                if ig.get("note"):
                    label += f" {ig['note']}"
                parts.append(label)
            for entry in server.get("not_served", []):
                ns_title, ns_version = _split_not_served(entry)
                if ns_title == title:
                    parts.append(f"not loaded: {ns_version}")
            cells.append("<br>".join(parts) if parts else "not checked")
        lines.append(f"| {md_cell(title)} | " + " | ".join(md_cell(c) for c in cells) + " |")
    lines.append("")
    lines.append(
        "Server holdings last checked: "
        + "; ".join(f"{s['name']} {fmt_date(_date(s['last_checked']))}" for s in servers)
        + "."
    )
    return "\n".join(lines)


def validate_canonicals(manifest: dict) -> str:
    lines = []
    for server in manifest["servers"]:
        lines.append(f"- {server['name']}:")
        for ig in server["igs"]:
            lines.append(
                f"  - {ig['title']} {ig['version']}: `{ig['profile_example']}|{ig['version']}`"
            )
    lines.append("")
    lines.append(
        "Each canonical above is one example profile from its IG; any other profile from the "
        "same IG takes the same `|version` suffix."
    )
    return "\n".join(lines)


def validate_example(manifest: dict) -> str:
    for server in manifest["servers"]:
        for ig in server["igs"]:
            if ig.get("unversioned_default"):
                return f"{ig['profile_example']}|{ig['version']}"
    ig = manifest["servers"][0]["igs"][0]
    return f"{ig['profile_example']}|{ig['version']}"


def data_section(manifest: dict) -> str:
    data = manifest["data"]
    lines = [
        "The shared `DEFAULT` partition of the Sparked FHIR server holds the HL7 AU test data, "
        f"loaded on {fmt_date(_date(data['loaded_on']))}:",
        "",
    ]
    for item in data["sets"]:
        repo_name = item["repo"].removeprefix("https://github.com/")
        tree = f"{item['repo']}/tree/{item['commit']}/{item['path']}"
        line = (
            f"- **{item['name']}**: [`{repo_name}` at `{item['commit'][:7]}`]({tree}) "
            f"(`{item['ref']}`)."
        )
        if item.get("note"):
            line += f" {item['note']}"
        lines.append(line)
    lines.append("")
    lines.append(data["note"])
    lines.append("")
    lines.append(
        "The upstream source is [hl7au/au-fhir-test-data](https://github.com/hl7au/au-fhir-test-data) "
        "(CC0). Load the same files into your own server with any FHIR client."
    )
    return "\n".join(lines)


def inferno_section(manifest: dict) -> str:
    inferno = manifest["inferno"]
    release = inferno["release"]
    planned = release["status"] == "planned"
    lines = [f"The AU test kits are hosted at [{inferno['url'].removeprefix('https://')}]({inferno['url']}).", ""]
    if planned:
        lines.append(
            f"Release {release['version']} is planned for this event and is not on the site yet; "
            f"the site runs {release['live_today']} today. Once promoted, the site stays on "
            f"{release['version']} through the change freeze ([promotion]({release['tracking']}))."
        )
    else:
        lines.append(
            f"The site runs release {release['version']} and stays on it through the change freeze."
        )
    lines.append("")
    if planned:
        lines.append("| Kit | Version for the event | On the site today | Suites |")
        lines.append("|---|---|---|---|")
    else:
        lines.append("| Kit | Version | Suites |")
        lines.append("|---|---|---|")
    for kit in inferno["kits"]:
        name = f"[{kit['name']}]({kit['page']})" if kit.get("page") else kit["name"]
        suites = "<br>".join(
            f"[{s['title']}]({inferno['url']}/suites/{s['id']})" for s in kit["suites"]
        )
        cells = [name, kit["version"]]
        if planned:
            cells.append(kit["live_today"])
        cells.append(suites)
        lines.append("| " + " | ".join(md_cell(c) for c in cells) + " |")
    notes = [f"- {kit['name']}: {kit['note']}" for kit in inferno["kits"] if kit.get("note")]
    if notes:
        lines.append("")
        lines.extend(notes)
    lines.append("")
    lines.append(
        "The AU Core Test Kit's **FHIR Endpoint** input starts filled in with the HL7 AU reference "
        "server; change it to your own server. See [Known issues](#known-issues) before a dry run "
        "against Sparked."
    )
    return "\n".join(lines)


def known_issues(manifest: dict) -> str:
    if not manifest["known_issues"]:
        return "None known."
    blocks = []
    for issue in manifest["known_issues"]:
        blocks.append(
            f"- **{issue['title']}** (checked {fmt_date(_date(issue['last_checked']))}). "
            f"{issue['detail']}\n  _What to do:_ {issue['workaround']}"
        )
    return "\n".join(blocks)


def status_section(manifest: dict) -> str:
    page = manifest["status_page"]
    if page["public"]:
        return f"Current service status: {page['url']}. {page['note']}"
    return page["note"]


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def lint_wording(text: str, source: str) -> None:
    hits = sorted({m.group(0) for m in BANNED_WORDS.finditer(text)})
    if hits:
        raise ManifestError(
            f"{source}: participant-facing text uses banned wording: {', '.join(hits)}"
        )


def render_guide(manifest: dict, access_code: str | None = None) -> str:
    ctx = build_context(manifest, access_code)
    template = (TEMPLATES_DIR / "participant-guide.md").read_text(encoding="utf-8")
    text = tidy(substitute(template, ctx, "participant-guide.md"))
    lint_wording(text, manifest["outputs"]["guide"])
    return text


def with_sandbox_status(manifest: dict, status: str) -> dict:
    variant = dict(manifest)
    variant["sandbox"] = {**manifest["sandbox"], "status": status}
    return variant


def lint_participant_text(manifest: dict) -> None:
    """Lint everything a participant may read, not only today's guide: the
    guide under every sandbox status (so a partial is checked before the
    go/no-go switches to it) and the loader banner."""
    for status in SANDBOX_STATUSES:
        render_guide(with_sandbox_status(manifest, status))
    banner = manifest["loader_banner"]
    lint_wording(f"{banner['title']}\n{banner['message']}", "loader_banner")


def anchor_dates(manifest: dict) -> dict[str, dt.date]:
    tz = ZoneInfo(manifest["timezone"])

    def local_date(value: str) -> dt.date:
        return dt.datetime.fromisoformat(value).astimezone(tz).date()

    return {
        "event_start": _date(manifest["dates"]["start"]),
        "event_end": _date(manifest["dates"]["end"]),
        "freeze_start": local_date(manifest["freeze"]["start"]),
        "freeze_end": local_date(manifest["freeze"]["end"]),
        "sandbox_opens": local_date(manifest["sandbox"]["opens"]),
        "sandbox_creation_closes": local_date(manifest["sandbox"]["creation_closes"]),
        "sandbox_expires": sandbox_expiry(manifest).date(),
    }


def render_checklist(manifest: dict, spec: dict | None = None) -> str:
    ctx = build_context(manifest)
    if spec is None:
        with (TEMPLATES_DIR / "operator-checklist.yaml").open(encoding="utf-8") as fh:
            spec = yaml.safe_load(fh)
    anchors = anchor_dates(manifest)
    start = anchors["event_start"]

    dated: list[tuple[dt.date, int, dict]] = []
    for order, item in enumerate(spec["items"]):
        if "only_for" in item and manifest["id"] not in item["only_for"]:
            continue
        if item["anchor"] not in anchors:
            raise ManifestError(f"operator-checklist.yaml: unknown anchor {item['anchor']!r}")
        day = anchors[item["anchor"]] + dt.timedelta(days=item["offset_days"])
        dated.append((day, order, item))
    dated.sort(key=lambda entry: (entry[0], entry[1]))

    lines = [
        f"# Operator checklist: {manifest['name']}",
        "",
        f"<!-- Generated from events/{manifest['id']}.yaml and events/templates/operator-checklist.yaml "
        "by scripts/render_event.py. Do not edit by hand. -->",
        "",
        f"Open the tracking issue with `gh issue create --title \"Operator checklist: {manifest['short_name']}\" "
        f"--body-file {manifest['outputs']['checklist']}`.",
        "",
        f"- Event: {ctx['event.dates']} (T = {fmt_date(start)})",
        f"- Freeze: {ctx['freeze.window']}",
        f"- Sandbox: {manifest['sandbox']['status']}, mode `{manifest['sandbox']['mode']}`; "
        f"opens {ctx['sandbox.opens']}; creation closes {ctx['sandbox.creation_closes']}; "
        f"expires {ctx['sandbox.expires']}",
        f"- Inferno: {manifest['inferno']['release']['version']} "
        f"({manifest['inferno']['release']['status']}); {manifest['inferno']['release']['tracking']}",
        f"- Participant guide: `{manifest['outputs']['guide']}`",
    ]
    current = None
    for day, _, item in dated:
        if day != current:
            current = day
            delta = (day - start).days
            label = "T" if delta == 0 else f"T{delta:+d}"
            lines += ["", f"## {fmt_date(day)} ({label})", ""]
        task = substitute(item["task"].strip(), ctx, "operator-checklist.yaml")
        # A multi-line task (code blocks and all) continues inside its list item.
        first, *rest = task.split("\n")
        prefix = "- [ ] **TODO, not yet written:** " if item.get("todo") else "- [ ] "
        lines.append(prefix + first)
        lines.extend(f"  {line}" if line else "" for line in rest)
    return tidy("\n".join(lines))


def outputs_for(manifest: dict) -> dict[Path, str]:
    lint_participant_text(manifest)
    return {
        REPO_ROOT / manifest["outputs"]["guide"]: render_guide(manifest),
        REPO_ROOT / manifest["outputs"]["checklist"]: render_checklist(manifest),
    }


# --------------------------------------------------------------------------
# Link check
# --------------------------------------------------------------------------

URL_RE = re.compile(r"https://[^\s)\]`'\"<>]+")


def check_links(manifest: dict) -> int:
    text = render_guide(manifest)
    smart = next((s.get("smart") for s in manifest["servers"] if s.get("smart")), {}) or {}
    post_only = {smart.get("token"), smart.get("authorize")}
    # A FHIR base answers GET with 400; its CapabilityStatement is the check.
    fhir_bases = (
        {s["fhir_base"] for s in manifest["servers"]}
        | {t["url"] for t in manifest["terminology"]}
        | {o["fhir_base"] for o in manifest.get("not_on_sparked", [])}
    )
    urls = []
    for url in URL_RE.findall(text):
        url = url.rstrip(".,;:")
        if url not in urls:
            urls.append(url)

    failures = 0
    for url in urls:
        if url in post_only or "$validate" in url:
            print(f"SKIP  {url}  (POST or browser endpoint)")
            continue
        fetch = url.split("#", 1)[0]
        if fetch in fhir_bases:
            fetch += "/metadata"
        request = urllib.request.Request(fetch, headers={"User-Agent": "sparked-event-link-check"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                print(f"OK    {response.status}  {url}" + ("  (/metadata)" if fetch != url.split("#", 1)[0] else ""))
        except urllib.error.HTTPError as err:
            expected = (
                err.code == 405 and "confluence.hl7.org" in fetch
            )  # AWS WAF blocks non-browser clients
            print(f"{'WARN' if expected else 'FAIL'}  {err.code}  {url}"
                  + ("  (WAF; check in a browser)" if expected else ""))
            failures += 0 if expected else 1
        except (urllib.error.URLError, TimeoutError) as err:
            pending = url.startswith(manifest["sandbox"]["url"]) and manifest["sandbox"]["status"] != "open"
            print(f"{'WARN' if pending else 'FAIL'}  ---  {url}  ({err})"
                  + ("  (sandbox not open yet)" if pending else ""))
            failures += 0 if pending else 1
    print(f"{len(urls)} links, {failures} failing")
    return 1 if failures else 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def manifest_paths(args_paths: list[str]) -> list[Path]:
    if args_paths:
        return [Path(p).resolve() for p in args_paths]
    return sorted(EVENTS_DIR.glob("*.yaml"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifests", nargs="*", help="event manifests (default: events/*.yaml)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="fail if a rendered file differs from the manifest")
    mode.add_argument("--check-links", action="store_true", help="GET every https link in the guide")
    mode.add_argument("--print-copy", metavar="OUT", help="write a printable guide with the access code from $EVENT_ACCESS_CODE")
    args = parser.parse_args(argv)

    try:
        paths = manifest_paths(args.manifests)
        if not paths:
            print("no event manifests found", file=sys.stderr)
            return 1

        if args.print_copy:
            if len(paths) != 1:
                parser.error("--print-copy takes exactly one manifest")
            out = Path(args.print_copy).resolve()
            if out.is_relative_to(REPO_ROOT):
                parser.error("--print-copy must write outside the repository: the access code is never committed")
            code = os.environ.get("EVENT_ACCESS_CODE", "").strip()
            if not code:
                parser.error("set EVENT_ACCESS_CODE for --print-copy")
            out.write_text(render_guide(load_manifest(paths[0]), access_code=code), encoding="utf-8")
            print(f"wrote {out}")
            return 0

        if args.check_links:
            return max(check_links(load_manifest(p)) for p in paths)

        drift = False
        for path in paths:
            manifest = load_manifest(path)
            for out, text in outputs_for(manifest).items():
                rel = out.relative_to(REPO_ROOT)
                current = out.read_text(encoding="utf-8") if out.exists() else ""
                if args.check:
                    if current != text:
                        drift = True
                        print(f"{rel} is out of date with {path.relative_to(REPO_ROOT)}:")
                        sys.stdout.writelines(
                            difflib.unified_diff(
                                current.splitlines(keepends=True),
                                text.splitlines(keepends=True),
                                fromfile=f"{rel} (committed)",
                                tofile=f"{rel} (rendered)",
                            )
                        )
                    else:
                        print(f"{rel} is up to date")
                elif current != text:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_text(text, encoding="utf-8")
                    print(f"wrote {rel}")
                else:
                    print(f"{rel} unchanged")
        if drift:
            print("\nRe-render with: python scripts/render_event.py", file=sys.stderr)
            return 1
        return 0
    except ManifestError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
