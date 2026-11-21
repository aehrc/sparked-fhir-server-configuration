# Operator checklist: HL7 Australia Work Group Meeting and FHIR Melbourne Connectathon

<!-- Generated from events/2026-12-melbourne.yaml and events/templates/operator-checklist.yaml by scripts/render_event.py. Do not edit by hand. -->

Open the tracking issue with `gh issue create --title "Operator checklist: Melbourne FHIR Connectathon #28" --body-file docs/operators/events/2026-12-melbourne-checklist.md`.

- Event: Tue 8 to Thu 10 Dec 2026 (T = Tue 8 Dec 2026)
- Freeze: Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT
- Sandbox: planned, mode `event`; opens Wed 2 Dec 2026, 09:00 AEDT; creation closes Thu 10 Dec 2026, 17:00 AEDT; expires Thu 17 Dec 2026, 17:00 AEDT
- Inferno: v1.2.3 (planned); https://github.com/hl7au/au-fhir-inferno/pull/223
- Participant guide: `docs/participants/2026-12-melbourne.md`

## Tue 24 Nov 2026 (T-14)

- [ ] Re-check every fact in `events/2026-12-melbourne.yaml` against the live services (version map, Inferno suites, data commits, known issues); update `last_checked`; run `python scripts/render_event.py --check-links events/2026-12-melbourne.yaml` and fix any link that fails.
- [ ] Confirm the version map with the track leads: Sparked serves the ballots, https://fhir.hl7.org.au/aucore/fhir/DEFAULT serves the stable releases. Make sure each track page links the right server.
- [ ] Ask the HL7 AU test data maintainers whether an event tag of hl7au/au-fhir-test-data is planned (as for earlier events); if it is, record it in `data` of the manifest.
- [ ] Turn the previous event's loader banner off at loader.sparked-fhir.com until git sets it from `loader_banner`.

## Fri 27 Nov 2026 (T-11)

- [ ] Sandbox service shown end to end on a scratch tenant: create, token, write, reset, expire.

## Mon 30 Nov 2026 (T-8)

- [ ] Sandbox go/no-go. Set `sandbox.status` to `open` or `cancelled` in the manifest, re-render, open the PR.

## Wed 2 Dec 2026 (T-6)

- [ ] Inferno: the promotion (https://github.com/hl7au/au-fhir-inferno/pull/223) is merged; `https://inferno.hl7.org.au/suites/api/test_suites` lists every suite in the manifest at the manifest's kit versions, including the SMART App Launch suites. Then set `inferno.release.status: live` and re-render.
- [ ] Merge the rendered guide; check that https://sandbox.sparked-fhir.com accepts the access code (if the sandbox is open).
- [ ] Loader banner: feed `loader_banner` to the loader's values and check https://loader.sparked-fhir.com/api/v1/public/event shows it.
- [ ] Post the guide link in the Sparked FHIR Server topic on Zulip and ask the track leads to link it from their track pages.

## Fri 4 Dec 2026 (T-4)

- [ ] Freeze starts at Fri 4 Dec 2026, 17:00 AEDT.
- [ ] **TODO, not yet written:** Freeze steps (Argo sync windows, Karpenter disruption freeze, tx.dev preload pause, Renovate pause, no Smile applies) with their exact commands and checks: to be added from the freeze checklist.

## Mon 7 Dec 2026 (T-1)

- [ ] Run the smoke suite from CI; every status check green.
- [ ] Warm the validator: one `$validate?profile=<canonical>|<version>` per IG version in the version map on https://smile.sparked-fhir.com/aucore/fhir/DEFAULT.
- [ ] Print the guide with the access code (`EVENT_ACCESS_CODE=... python scripts/render_event.py --print-copy <file outside the repo> events/2026-12-melbourne.yaml`) and put the code on the venue slides. Never commit the code.
- [ ] Run `--check-links` once more.

## Tue 8 Dec 2026 (T)

- [ ] Each event morning: status checks, Inferno suite list, sandbox count against the cap of 60; watch the Zulip topics in the guide's Help section; note problems for the retro.

## Wed 9 Dec 2026 (T+1)

- [ ] Morning checks as on day 1.

## Thu 10 Dec 2026 (T+2)

- [ ] Morning checks as on day 1.
- [ ] Sandbox creation closes at Thu 10 Dec 2026, 17:00 AEDT; check the front refuses new sandboxes.

## Fri 11 Dec 2026 (T+3)

- [ ] Freeze ends at Fri 11 Dec 2026, 17:00 AEDT.
- [ ] **TODO, not yet written:** Unfreeze steps, the reverse of the freeze steps, with their checks: to be added from the freeze checklist.
- [ ] Retro from the status history, the sandbox register and the Zulip topics.

## Thu 17 Dec 2026 (T+9)

- [ ] Sandbox expiry ran at Thu 17 Dec 2026, 17:00 AEDT: every event sandbox is disabled and its data deleted; retire the access code.
- [ ] Turn the loader banner off; close this issue.
