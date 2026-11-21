#!/usr/bin/env python3
"""Tests for scripts/render_event.py. Run: python scripts/test_render_event.py"""

from __future__ import annotations

import copy
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render_event as r  # noqa: E402

MANIFESTS = sorted(r.EVENTS_DIR.glob("*.yaml"))


def first_manifest() -> tuple[Path, dict]:
    path = MANIFESTS[0]
    return path, r.load_manifest(path)


class ManifestTests(unittest.TestCase):
    def test_every_manifest_validates_and_renders(self):
        self.assertTrue(MANIFESTS, "no manifests under events/")
        for path in MANIFESTS:
            with self.subTest(manifest=path.name):
                manifest = r.load_manifest(path)
                guide = r.render_guide(manifest)
                self.assertNotIn("{{", guide)
                self.assertIn(manifest["servers"][0]["fhir_base"], guide)
                self.assertNotIn("{{", r.render_checklist(manifest))

    def test_unknown_key_is_rejected(self):
        path, manifest = first_manifest()
        bad = copy.deepcopy(manifest)
        bad["sandbox"]["acess_code"] = "typo"
        with self.assertRaisesRegex(r.ManifestError, "acess_code"):
            r.validate_manifest(bad, path)

    def test_offset_must_match_timezone(self):
        path, manifest = first_manifest()
        bad = copy.deepcopy(manifest)
        moment = bad["freeze"]["start"]
        bad["freeze"]["start"] = moment[:-6] + ("+10:00" if not moment.endswith("+10:00") else "+11:00")
        with self.assertRaisesRegex(r.ManifestError, "offset does not match"):
            r.validate_manifest(bad, path)

    def test_freeze_must_cover_the_event(self):
        path, manifest = first_manifest()
        bad = copy.deepcopy(manifest)
        bad["freeze"]["end"] = bad["dates"]["start"] + bad["freeze"]["end"][10:]
        with self.assertRaisesRegex(r.ManifestError, "freeze window must cover"):
            r.validate_manifest(bad, path)

    def test_id_must_match_file_name(self):
        path, manifest = first_manifest()
        bad = copy.deepcopy(manifest)
        bad["id"] = "1999-01-elsewhere"
        with self.assertRaisesRegex(r.ManifestError, "must match the file name"):
            r.validate_manifest(bad, path)


class RenderingTests(unittest.TestCase):
    def test_unknown_placeholder_fails(self):
        with self.assertRaisesRegex(r.ManifestError, "no.such.key"):
            r.substitute("{{ no.such.key }}", {}, "test")

    def test_banned_wording_fails(self):
        for text in ("Conformance results", "certified", "all tests pass", "Verified by"):
            with self.subTest(text=text), self.assertRaises(r.ManifestError):
                r.lint_wording(text, "test")
        r.lint_wording("Enter your password; the passcode is on the slides", "test")

    def test_access_code_only_in_print_copy(self):
        _, manifest = first_manifest()
        self.assertNotIn("TEST-CODE-123", r.render_guide(manifest))
        if manifest["sandbox"]["status"] != "cancelled":
            self.assertIn("TEST-CODE-123", r.render_guide(manifest, access_code="TEST-CODE-123"))

    def test_print_copy_refuses_a_path_in_the_repo(self):
        path, _ = first_manifest()
        os.environ["EVENT_ACCESS_CODE"] = "TEST-CODE-123"
        try:
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                r.main(["--print-copy", str(r.REPO_ROOT / "guide-print.md"), str(path)])
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "guide.md"
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(r.main(["--print-copy", str(out), str(path)]), 0)
                self.assertTrue(out.exists())
        finally:
            del os.environ["EVENT_ACCESS_CODE"]

    def test_checklist_runs_from_two_weeks_out(self):
        _, manifest = first_manifest()
        checklist = r.render_checklist(manifest)
        headings = [line for line in checklist.splitlines() if line.startswith("## ")]
        self.assertTrue(headings[0].endswith("(T-14)"), headings[0])
        self.assertNotIn("TODO, not yet written", checklist)

    def test_checklist_items_todo_only_for_and_multiline(self):
        _, manifest = first_manifest()
        spec = {
            "items": [
                {"anchor": "event_start", "offset_days": 0, "todo": True, "task": "Write this step."},
                {"anchor": "event_start", "offset_days": 0, "only_for": ["1999-01-elsewhere"], "task": "Hidden."},
                {"anchor": "event_end", "offset_days": 0, "task": "Run:\n```sh\necho {{ event.id }}\n```\n"},
            ]
        }
        checklist = r.render_checklist(manifest, spec)
        self.assertIn("- [ ] **TODO, not yet written:** Write this step.", checklist)
        self.assertNotIn("Hidden.", checklist)
        self.assertIn(f"- [ ] Run:\n  ```sh\n  echo {manifest['id']}\n  ```", checklist)

    def test_freeze_values_match_the_window(self):
        _, manifest = first_manifest()
        ctx = r.build_context(manifest)
        self.assertEqual(ctx["freeze.cron_local"], "0 17 4 12 *")
        self.assertEqual(ctx["freeze.cron_utc"], "0 6 4 12 *")
        self.assertEqual(ctx["freeze.duration"], "168h")

    def test_committed_outputs_match(self):
        with redirect_stdout(io.StringIO()) as out:
            code = r.main(["--check"])
        self.assertEqual(code, 0, out.getvalue())


# Sentences that state sandbox behaviour as fact. None may render unless the
# sandbox is open.
SANDBOX_FACTS = (
    "your own sandbox",
    "your sandbox page",
    "sandbox token",
    "SANDBOX_BASE",
    "writes go to",
    "writable sandboxes, the hosted",
    "Writable sandboxes are **open**",
    "sandbox login user",
)


class SandboxStatusTests(unittest.TestCase):
    def render(self, status: str) -> str:
        _, manifest = first_manifest()
        return r.render_guide(r.with_sandbox_status(manifest, status))

    def test_every_status_partial_has_every_slot(self):
        for status in r.SANDBOX_STATUSES:
            with self.subTest(status=status):
                self.assertEqual(set(r.sandbox_slots(status)), set(r.SANDBOX_SLOTS))

    def test_cancelled_guide_states_no_sandbox_as_fact(self):
        _, manifest = first_manifest()
        guide = self.render("cancelled")
        for phrase in SANDBOX_FACTS:
            with self.subTest(phrase=phrase):
                self.assertNotIn(phrase, guide)
        self.assertNotIn(manifest["sandbox"]["url"], guide)
        self.assertIn("no self-serve sandboxes", guide)

    def test_planned_guide_states_no_sandbox_as_fact_outside_the_plan(self):
        guide = self.render("planned")
        # The Sandboxes section describes the plan; nothing else may assume it.
        before, _, rest = guide.partition("## Sandboxes")
        _, _, after = rest.partition("\n## ")
        for phrase in SANDBOX_FACTS:
            with self.subTest(phrase=phrase):
                self.assertNotIn(phrase, before + after)

    def test_open_guide_has_the_recipes(self):
        guide = self.render("open")
        self.assertIn("### Backend services: client credentials", guide)
        self.assertIn("SANDBOX_BASE", guide)

    def test_guide_template_leaves_sandboxes_to_the_partials(self):
        """participant-guide.md may name the Sandboxes section but never
        describe sandboxes: that text belongs in the status partials."""
        template = (r.TEMPLATES_DIR / "participant-guide.md").read_text(encoding="utf-8")
        stripped = r.PLACEHOLDER.sub("", template)
        for allowed in ("[Sandboxes](#sandboxes)", "## Sandboxes", "| Sandboxes |"):
            stripped = stripped.replace(allowed, "")
        self.assertNotRegex(stripped.lower(), r"sandbox")

    def test_manifest_text_outside_the_partials_states_no_sandbox_as_fact(self):
        _, manifest = first_manifest()
        for server in manifest["servers"]:
            self.assertNotIn("sandbox", server["access"].lower())

    def test_lint_covers_other_statuses_and_the_loader_banner(self):
        _, manifest = first_manifest()
        bad = copy.deepcopy(manifest)
        bad["sandbox"]["status"] = "planned"
        bad["sandbox"]["fallback"] = "Ask for a certified sandbox."  # cancelled partial only
        with self.assertRaisesRegex(r.ManifestError, "banned wording"):
            r.lint_participant_text(bad)
        bad = copy.deepcopy(manifest)
        bad["loader_banner"]["message"] = "All servers passed."
        with self.assertRaisesRegex(r.ManifestError, "loader_banner"):
            r.lint_participant_text(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
