# Operator checklist: HL7 Australia Work Group Meeting and FHIR Melbourne Connectathon

<!-- Generated from events/2026-12-melbourne.yaml and events/templates/operator-checklist.yaml by scripts/render_event.py. Do not edit by hand. -->

Open the tracking issue with `gh issue create --title "Operator checklist: Melbourne FHIR Connectathon #28" --body-file docs/operators/events/2026-12-melbourne-checklist.md`.

- Event: Tue 8 to Thu 10 Dec 2026 (T = Tue 8 Dec 2026)
- Freeze: Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT
- Sandbox: planned, mode `event`; opens Wed 2 Dec 2026, 09:00 AEDT; creation closes Thu 10 Dec 2026, 17:00 AEDT; expires Thu 17 Dec 2026, 17:00 AEDT
- Inferno: v1.2.3 (planned); https://github.com/hl7au/au-fhir-inferno/pull/223
- Participant guide: `docs/participants/2026-12-melbourne.md`

## Tue 24 Nov 2026 (T-14)

- [ ] Re-check every fact in `events/2026-12-melbourne.yaml` against the live services (version map, `not_on_sparked`, Inferno suites, data commits, known issues); update `last_checked`; run `python scripts/render_event.py --check-links events/2026-12-melbourne.yaml` and fix any link that fails.
- [ ] Confirm the version map with the track leads: Sparked serves the ballots, https://fhir.hl7.org.au/aucore/fhir/DEFAULT serves the stable releases. Make sure each track page links the right server, and that every track whose IG Sparked does not serve is in `not_on_sparked`.
- [ ] Ask the HL7 AU test data maintainers whether an event tag of hl7au/au-fhir-test-data is planned (as for earlier events); if it is, record it in `data` of the manifest.
- [ ] Turn the previous event's loader banner off at loader.sparked-fhir.com until git sets it from `loader_banner`.

## Fri 27 Nov 2026 (T-11)

- [ ] Sandbox service shown end to end on a scratch tenant: create, token, write, reset, expire.

## Mon 30 Nov 2026 (T-8)

- [ ] Sandbox go/no-go. Set `sandbox.status` to `open` or `cancelled` in the manifest, re-render, open the PR.
- [ ] **Smile node roll (one-off; must happen, or Smile restarts at 12:29 AEDT on Thu 10 Dec).** The live NodeClaim `on-demand-prod-pr76v` was created 2026-11-10T01:29:08Z with `expireAfter: 720h` and expires 2026-12-10T01:29:08Z; disruption budgets cannot stop expiration in Karpenter v1.
  1. On a weekday before Tue 1 Dec, merge aehrc/sparked-argo#384 (`on-demand-prod` `expireAfter: Never`) during the day. It is not inert: Karpenter replaces the node gracefully (new node first) at 19:00 AEDT that evening, when the Drifted budget opens, and Smile restarts once (cold boot up to about 30 minutes).
  2. At 19:00 AEDT, watch:
     ```sh
     kubectl --context sparkey get nodeclaims -l karpenter.sh/nodepool=on-demand-prod -w
     kubectl --context sparkey -n smile get pods -w
     curl -s -o /dev/null -w '%{http_code}\n' https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata
     ```
     Expect one new NodeClaim, the old one gone, the pod Ready, then `200`.
  3. Check: `kubectl --context sparkey get nodeclaims -l karpenter.sh/nodepool=on-demand-prod -o jsonpath='{.items[*].spec.expireAfter}{"\n"}'` prints `Never`.
  4. If #384 is not merged by Tue 1 Dec, the fallback is a forceful roll at a chosen hour, `kubectl --context sparkey delete nodeclaim on-demand-prod-pr76v` (no pre-spun node, so a longer gap). It is a cluster write: Kyle's call.

## Tue 1 Dec 2026 (T-7)

- [ ] **Inferno prod ref (one-off; before the promotion merges).**
  1. Merge hl7au/au-fhir-inferno#226 (`prod-release.yaml` fast-forwards a `prod` branch to each promotion merge).
  2. Bootstrap the branch at the current `master` head, which is what prod renders today:
     ```sh
     cd ~/Documents/repos/au-fhir-inferno && git fetch origin
     git push origin origin/master:refs/heads/prod
     git rev-parse origin/master
     kubectl --context sparkey -n argocd get app inferno-prod -o jsonpath='{.status.sync.revision}{"\n"}'
     ```
     The two SHAs must match. If `master` moved after Argo's last sync, wait for `inferno-prod` to sync it first. **Record this SHA in this issue:** it is the rollback target for the first promotion after the switch (https://github.com/hl7au/au-fhir-inferno/pull/223), because the previous tag's chart predates chart changes that prod already runs.
  3. Merge aehrc/sparked-argo#381 (`inferno-prod` renders `targetRevision: prod`) straight after. Check: `kubectl --context sparkey -n argocd get app inferno-prod -o jsonpath='{.spec.source.targetRevision} {.status.sync.status} {.status.health.status} {.status.sync.revision}{"\n"}'` prints `prod Synced Healthy <same SHA>`.
  4. `PROMOTE_TOKEN` needs Contents and Workflows read and write; without Workflows, a promotion whose range changes a workflow file fails at the move step and a release owner pushes `prod` by hand.
- [ ] **Freeze PRs (one-off setup; merge by Wed 2 Dec).** None acts on the cluster before Fri 4 Dec 2026, 17:00 AEDT, except that #383's business-hours budget is live on merge (it rolls no node).
  1. Argo CD sync windows: merge aehrc/sparked-argo#382 (deny windows plus `scripts/event-freeze.py`). Check:
     ```sh
     kubectl --context sparkey -n argocd get appproject inferno sparked -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.syncWindows[*].schedule} {.spec.syncWindows[*].timeZone} {.spec.syncWindows[*].duration}{"\n"}{end}'
     ```
     Expect `0 17 4 12 * Australia/Sydney 168h` for both.
  2. Karpenter budgets: merge aehrc/sparked-argo#383 after #382 (GitHub retargets it to `main`). Check:
     ```sh
     kubectl --context sparkey get nodepools -o custom-columns=NAME:.metadata.name,BUDGETS:.spec.disruption.budgets
     ```
     Expect on `on-demand` and `spot`: `nodes:1`, the `0 21 * * *` 11h budget, and the `0 6 4 12 *` 168h budget; `on-demand-prod`: the `0 6 4 12 *` 168h budget with no reasons; `spot-arm64`: the `0 21 * * *` budget. No NodeClaim should change.
  3. tx.dev preload overlay and Renovate pause: merge aehrc/sparked-argo#385 (the overlay, commented out; renders nothing new) and #386 (Renovate skips scheduled runs inside a rendered freeze; after #382).

## Wed 2 Dec 2026 (T-6)

- [ ] Inferno: the promotion (https://github.com/hl7au/au-fhir-inferno/pull/223) is merged through the `prod` branch path. Check:
  ```sh
  git -C ~/Documents/repos/au-fhir-inferno fetch origin && git -C ~/Documents/repos/au-fhir-inferno log -1 --format='%h %s' origin/prod
  ```
  shows the promotion's merge commit, and `https://inferno.hl7.org.au/suites/api/test_suites` lists every suite in the manifest at the manifest's kit versions, including the SMART App Launch suites. Then set `inferno.release.status: live` and re-render.
- [ ] Once hl7au/au-fhir-inferno#227 is live and `https://inferno.hl7.org.au/test-kits/smart-app-launch/` answers 200, add it as `page:` of the SMART App Launch Test Kit in the manifest and re-render.
- [ ] Merge the rendered guide; check that https://sandbox.sparked-fhir.com accepts the access code (if the sandbox is open).
- [ ] If the sandbox is open: run each Auth recipe in the guide verbatim against a sandbox (backend services, bearer token on each request, SMART App Launch with PKCE) and fix the guide where a step differs.
- [ ] If the sandbox is open: send the event access code to the organisers for their pre-event message to registered participants, and post it in the Sparked FHIR Server topic on Zulip. Kyle posts on Zulip; an agent never does. Never commit the code.
- [ ] Loader banner: feed `loader_banner` to the loader's values and check https://loader.sparked-fhir.com/api/v1/public/event shows it.
- [ ] Post the guide link in the Sparked FHIR Server topic on Zulip and ask the track leads to link it from their track pages. Kyle posts on Zulip; an agent never does.

## Thu 3 Dec 2026 (T-5)

- [ ] **Last checks before the freeze.**
  1. NodeClaim ages: any node created between Wed 4 Nov 2026, 17:00 AEDT and Wed 11 Nov 2026, 17:00 AEDT expires inside the freeze.
     ```sh
     kubectl --context sparkey get nodeclaims -o custom-columns=NAME:.metadata.name,POOL:.metadata.labels.karpenter\\.sh/nodepool,CREATED:.metadata.creationTimestamp,EXPIRE:.spec.expireAfter
     ```
     Spot nodes usually go sooner; if one is still there, decide whether to roll it this evening (`kubectl delete nodeclaim <name>`, a cluster write).
  2. Ask whoever publishes to the `hl7au-dev` and `hl7au-fragments` syndication feeds to hold from Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT: a replica restart still runs the startup preload.
  3. Tell maintainers: no merges to aehrc/sparked-argo `main` and no Smile `terraform apply` from Fri 4 Dec 2026, 17:00 AEDT except emergencies; no Inferno promotion merges.

## Fri 4 Dec 2026 (T-4)

- [ ] **Between 09:00 and 16:00: pause the tx.dev preload.** (After the freeze starts, the `ontoserver` sync window blocks the automated sync; a manual sync still works.)
  ```sh
  cd ~/Documents/repos/sparked-argo && git fetch origin
  git worktree add -b freeze/tx-dev-preload-on ../sparked-worktrees/tx-preload-on origin/main
  cd ../sparked-worktrees/tx-preload-on
  sed -i '' 's|^          # - \$values/apps/ontoserver/values-event-freeze.yaml$|          - $values/apps/ontoserver/values-event-freeze.yaml|' apps/ontoserver.yaml
  git diff --stat   # 1 file, 1 line
  git commit -am "Pause tx.dev's nightly preload for the event freeze" && git push -u origin HEAD
  gh pr create --fill && gh pr merge --squash --delete-branch
  ```
  Both replicas roll one at a time (about 2.5 minutes each). Check:
  ```sh
  kubectl --context sparkey -n ontoserver get sts ontoserver-statefulset -o jsonpath='{.spec.template.spec.containers[?(@.name=="ontoserver-ontoserver")].env[?(@.name=="atom.preload.schedule.cron")].value}{"\n"}'   # prints -
  kubectl --context sparkey -n ontoserver get pods   # both Ready
  curl -s -o /dev/null -w '%{http_code}\n' 'https://tx.dev.hl7.org.au/fhir/CodeSystem/$validate-code?url=http://snomed.info/sct&code=38341003'   # 200
  ```
- [ ] Freeze starts at Fri 4 Dec 2026, 17:00 AEDT. Nothing to do at that moment: the Argo CD sync windows, Karpenter event budgets and Renovate skip all start on their own.
- [ ] **From five minutes after the freeze starts: confirm.**
  - Argo CD: the UI shows a red "Sync Denied" window on `inferno-prod`, `ontoserver`, `smilecdr-routes` and the rest of the list; or with the CLI, `argocd proj windows list sparked` and `argocd app get inferno-prod` (Sync Window: Sync Denied). One look that self-heal is held: `kubectl --context sparkey -n argocd get app inferno-prod -o jsonpath='{.status.conditions}{"\n"}'`.
  - Karpenter: in Grafana Explore (Mimir), `karpenter_nodepools_allowed_disruptions{nodepool=~"on-demand|on-demand-prod|spot"}` drops to 0 for the frozen reasons.
  - Smile: no `terraform apply` until the freeze ends (convention; Smile is not in Argo CD).
  - Inferno: no promotion merge until the freeze ends (`prod` only moves on one).
- [ ] **During the freeze (keep for reference).**
  - Emergency change to a frozen app: merge the fix, then sync it by hand: Argo CD UI, the Application, Sync (allowed because every window sets `manualSync: true`). With kubectl only:
    ```sh
    kubectl --context sparkey -n argocd patch application <app> --type merge \
      -p '{"operation":{"initiatedBy":{"username":"<you>"},"sync":{"syncStrategy":{"hook":{}}}}}'
    ```
  - Emergency Inferno rollback: a release owner moves `prod` back to where it was before the last promotion, then syncs `inferno-prod` by hand. For the first promotion after the `prod` switch, that is the bootstrap SHA recorded in this issue, not the previous tag: `git -C ~/Documents/repos/au-fhir-inferno push --force origin <bootstrap sha>:refs/heads/prod`. For later releases, the previous tag: `git -C ~/Documents/repos/au-fhir-inferno push --force origin 'vX.Y.Z^{commit}:refs/heads/prod'`.
  - Emergency dependency bump: Actions, Renovate, Run workflow, tick `ignore_freeze`.
  - Emergency node repack: karpenter-config is not in a window; delete the event block from the NodePool and merge.
  - Lift the whole freeze early: merge `python3 scripts/event-freeze.py clear` (the clear step at the freeze end) and resume the tx.dev preload.
  - Renovate's scheduled runs inside the freeze should show as skipped: `gh run list -R aehrc/sparked-argo --workflow renovate.yaml -L 2`.

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

- [ ] Freeze ends at Fri 11 Dec 2026, 17:00 AEDT. Nothing to do at that moment: the sync windows and event budgets end on their own.
- [ ] **After the freeze ends: resume the tx.dev preload.** (Before then the window holds the sync.)
  ```sh
  cd ~/Documents/repos/sparked-argo && git fetch origin
  git worktree add -b freeze/tx-dev-preload-off ../sparked-worktrees/tx-preload-off origin/main
  cd ../sparked-worktrees/tx-preload-off
  sed -i '' 's|^          - \$values/apps/ontoserver/values-event-freeze.yaml$|          # - $values/apps/ontoserver/values-event-freeze.yaml|' apps/ontoserver.yaml
  git commit -am "Resume tx.dev's nightly preload after the event freeze" && git push -u origin HEAD
  gh pr create --fill && gh pr merge --squash --delete-branch
  ```
  Check that the same `kubectl get sts` command as at the freeze start prints `0 0 15 * * *` and both pods are Ready.
- [ ] **Clear the rendered freeze blocks** (the crons recur next year otherwise; the sparked-argo render CI turns every PR red from the freeze end until this lands):
  ```sh
  cd ~/Documents/repos/sparked-argo && git fetch origin
  git worktree add -b freeze/clear-2026-12-melbourne ../sparked-worktrees/freeze-clear origin/main
  cd ../sparked-worktrees/freeze-clear
  python3 scripts/event-freeze.py clear && python3 scripts/event-freeze.py check
  git commit -am "Clear the 2026-12-melbourne event freeze blocks" && git push -u origin HEAD
  gh pr create --fill
  ```
  Merge after review. Check: `kubectl --context sparkey -n argocd get appproject inferno sparked -o jsonpath='{.items[*].spec.syncWindows}'` prints nothing, and the NodePools lose the `0 6 4 12 *` budget (the business-hours budget stays).
- [ ] Tell maintainers the freeze is over and release the feed publishing hold. Renovate resumes on its own; work through its backlog one PR at a time. For the next event, run `python3 scripts/event-freeze.py render --manifest <raw URL of events/<event>.yaml>` in a sparked-argo worktree and merge that PR before its freeze (sparked-argo docs/event-freeze.md).
- [ ] Retro from the status history, the sandbox register and the Zulip topics.

## Thu 17 Dec 2026 (T+9)

- [ ] Sandbox expiry ran at Thu 17 Dec 2026, 17:00 AEDT: every event sandbox is disabled and its data deleted; retire the access code.
- [ ] Turn the loader banner off; close this issue.
