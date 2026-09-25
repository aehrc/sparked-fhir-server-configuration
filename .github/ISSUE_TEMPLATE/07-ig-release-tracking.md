---
name: IG Release Tracking (maintainers)
about: One issue per published IG version, tracking it through every Sparked target from publication to announcement. For requesting a package on the FHIR server, use the Implementation Guide Release Request instead.
title: "[IG Tracking]: <IG name> <version>"
labels: ["ig-release-tracking"]
assignees: []
---

<!--
Maintainers only. Follow the runbook for each step:
https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md

Tick each box as it is done and paste the evidence (link or command output) as a comment.
Strike through (~~text~~) and write "n/a" beside any step that does not apply to this IG;
the scope table in section 1 of the runbook says which targets each IG reaches.
This issue does NOT trigger any automation. The Smile server request (step 2.1) is a
separate Implementation Guide Release Request issue.
-->

## Release

| Field | Value |
|---|---|
| IG name | |
| Package id | `hl7.fhir.au.` |
| Version | |
| Status (draft / ballot / preview / trial-use) | |
| Published date (`package-list.json` `date`) | |
| IG link | https://hl7.org.au/fhir/ |
| Declared dependencies (step 0.2) | |
| Related tracking issues (for example AU Base for an AU Core ballot) | |
| Suite this release replaces on the Inferno site | |

## Targets that apply

- [ ] tx.dev
- [ ] Sparked Dev FHIR Server (`aucore`)
- [ ] Test data
- [ ] Inferno test kit and platform

## Phase 0: Detect

- [ ] 0.1 Package is on `packages.fhir.org` (GET returns 200) ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-0-1))
- [ ] 0.2 Fields above filled in, dependency list recorded, related tracking issues linked ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-0-2))

## Phase 1: tx.dev

- [ ] 1.1 Feeder picked the version up. AU PS only: pin edited in [`tx-dev-helm-values.yaml`](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/terminology-servers/tx-dev-helm-values.yaml) through a PR ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-1-1))
- [ ] 1.2 tx.dev returns the new version's StructureDefinition (after the daily 15:00 UTC sync) ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-1-2))

## Phase 2: Sparked Dev FHIR Server (`aucore`)

- [ ] 2.1 [Implementation Guide Release Request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=01-ig-release-request.yml) raised with **STORE_AND_INSTALL** ticked: # ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-2-1))
- [ ] 2.2 Dependencies checked, coupled packages batched, PR opened: # ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-2-2))
- [ ] 2.3 PR merged and deployed with [Re/load IG Packages](https://github.com/aehrc/sparked-fhir-server-configuration/actions/workflows/reload-ig-config.yml); versioned `$validate` resolves ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-2-3))
- [ ] 2.4 Seed config persisted with Terraform; live `startup_installation_specs` matches the repo ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-2-4))
- [ ] 2.5 AU PS only: `$summary` generator checked ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-2-5))

## Phase 3: Test data

- [ ] 3.1 Test data change merged in `hl7au/au-fhir-test-data`, or "no change" recorded ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-3-1))
- [ ] 3.2 `aucore` reloaded with [Manage Test Data](https://github.com/aehrc/sparked-fhir-server-configuration/actions/workflows/manage-test-data.yml) (dry run first) ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-3-2))

## Phase 4: Test kit (gem)

- [ ] 4.1 Kit issue opened, naming the suite it replaces: hl7au/ ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-4-1))
- [ ] 4.2 Suite generated; every `igs` line names the package id, no `/home/igs` path ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-4-2))
- [ ] 4.3 Kit PR previewed with the `preview` label; session link recorded ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-4-3))
- [ ] 4.4 Version bump merged, **then** tag and GitHub Release; publish-gem green ([AU Core](https://github.com/hl7au/au-fhir-core-inferno/actions/workflows/publish-gem.yaml), [AU PS](https://github.com/hl7au/au-ps-inferno/actions/workflows/publish-gem.yaml)); gem version: ; built with `inferno_suite_generator` ref: ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-4-4))

## Phase 5: Inferno platform, staging

- [ ] 5.1 [`au-fhir-inferno`](https://github.com/hl7au/au-fhir-inferno) PR changes all four together: `Gemfile`+lock, `Gemfile.dev`+lock, warmer (count at most `sessionCacheSize`), kit page `suites`/`version`/`date`; generator ref in `Gemfile.common` checked; preview run passes: hl7au/au-fhir-inferno# ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-5-1))
- [ ] 5.2 Merged; staging `/suites/api/test_suites` lists the new suite ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-5-2))

## Phase 6: Inferno platform, production

- [ ] 6.1 Promotion PR for the staging SHA merged; [prod-release](https://github.com/hl7au/au-fhir-inferno/actions/workflows/prod-release.yaml) tagged `v` and production lists the new suite ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-6-1))

## Phase 7: Smoke run, hand-off, announce

- [ ] 7.1 Smoke run on production Inferno against `aucore` completed; session link: ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-7-1))
- [ ] 7.2 Reference environment owners told (`fhir.hl7.org.au`, tx.hl7); who and when: ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-7-2))
- [ ] 7.3 Kit issue and Smile request issues closed ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-7-3))
- [ ] **Announced** on [chat.fhir.org, australia > Inferno Test Kit feedback and queries](https://chat.fhir.org/#narrow/channel/179173-australia/topic/Inferno.20Test.20Kit.20feedback.20and.20queries); link: ([runbook](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/runbooks/ig-release.md#step-7-3))

## Close-out

Elapsed days from publication to announcement: 

Anything that went wrong, or a runbook step that was wrong (fix the runbook in the same week):
