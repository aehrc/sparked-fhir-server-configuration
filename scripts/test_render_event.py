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
        self.assertIn("TODO, not yet written", checklist)

    def test_committed_outputs_match(self):
        with redirect_stdout(io.StringIO()) as out:
            code = r.main(["--check"])
        self.assertEqual(code, 0, out.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
