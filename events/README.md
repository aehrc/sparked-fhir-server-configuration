# Event manifests

One YAML file per event that Sparked serves, named `<yyyy-mm>-<place>.yaml`.
Each manifest is the single place where an event's dates, freeze window,
version map, Inferno release, data pin, sandbox settings, help channels and
known issues are written down. From it, `scripts/render_event.py` renders:

- the participant guide, `docs/participants/<event>.md`
- the operator checklist, `docs/operators/events/<event>-checklist.md`, which
  the operator opens as a GitHub issue (`gh issue create --body-file ...`)

CI (`.github/workflows/validate-events.yml`) validates every
manifest against `schema/event-manifest.schema.json` and fails if a rendered
file differs from what its manifest renders to.

## Layout

| Path | What it is |
|---|---|
| `<event>.yaml` | The manifest for one event |
| `schema/event-manifest.schema.json` | JSON Schema for a manifest |
| `templates/participant-guide.md` | Hand-written guide prose, with `{{ placeholders }}` |
| `templates/sandbox-*.md` | The guide's sandbox section, one file per sandbox status |
| `templates/operator-checklist.yaml` | Checklist items, each dated relative to the event |
| `requirements.txt` | The renderer's pinned dependencies |

## Adding the next event

1. Copy the latest manifest to the new event's name and change `id` to match.
2. Update every section, re-checking each fact against the live services, and
   set each `last_checked`. Datetimes carry an explicit offset, which the
   renderer checks against `timezone` (daylight saving is easy to get wrong).
3. Render and check:

   ```bash
   pip install -r events/requirements.txt
   python scripts/render_event.py events/<event>.yaml
   python scripts/render_event.py --check-links events/<event>.yaml
   python scripts/test_render_event.py
   ```

4. Commit the manifest and both rendered files together.

Change the prose for every event in `templates/`; change facts in the manifest.
Never edit a rendered file by hand.

## Rules the renderer enforces

- The participant guide never uses the words conformance, certification,
  pass or verified. (It also never shows results for a named vendor; that
  one is a review rule, not checked by the renderer.)
- Unknown placeholders, unknown manifest keys and inconsistent dates fail
  the render.

## The sandbox access code

The access code keeps crawlers out of the event sandbox front, so it is never
written to this public repository. It is handed out on the day: on the venue
slides and in a printed copy of the guide, produced with

```bash
EVENT_ACCESS_CODE=... python scripts/render_event.py --print-copy /path/outside/the/repo.md events/<event>.yaml
```

which refuses to write inside the repository.

## Statuses that change the guide

- `sandbox.status`: `planned` until the go/no-go, then `open` or `cancelled`.
  Each has its own section text in `templates/sandbox-<status>.md`.
- `inferno.release.status`: `planned` until the promotion merges and the site
  serves the release, then `live`.

Change the status, re-render, and commit.

## The loader banner

`loader_banner` holds the event block for loader.sparked-fhir.com (`enabled`,
`title`, `message`, `date`, the same fields as the loader's own helm values),
so the banner text is reviewed with the rest of the event and can be fed to
the loader from here.
