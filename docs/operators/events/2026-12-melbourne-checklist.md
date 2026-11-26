# Operator checklist: HL7 Australia Work Group Meeting and FHIR Melbourne Connectathon

<!-- Generated from events/2026-12-melbourne.yaml and events/templates/operator-checklist.yaml by scripts/render_event.py. Do not edit by hand. -->

Open the tracking issue with `gh issue create --title "Operator checklist: Melbourne FHIR Connectathon #28" --body-file docs/operators/events/2026-12-melbourne-checklist.md`.

- Event: Tue 8 to Thu 10 Dec 2026 (T = Tue 8 Dec 2026)
- Freeze: Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT
- Sandbox: planned, mode `event`; opens Wed 2 Dec 2026, 09:00 AEDT; creation closes Thu 10 Dec 2026, 17:00 AEDT; expires overnight from Thu 17 to Fri 18 Dec 2026 (AEDT)
- Inferno: v1.2.3 (planned); https://github.com/hl7au/au-fhir-inferno/pull/223
- Participant guide: `docs/participants/2026-12-melbourne.md`

## Tue 24 Nov 2026 (T-14)

- [ ] Re-check every fact in `events/2026-12-melbourne.yaml` against the live services (version map, `not_on_sparked`, Inferno suites, data commits, known issues); update `last_checked`; run `python scripts/render_event.py --check-links events/2026-12-melbourne.yaml` and fix any link that fails.
- [ ] Confirm the version map with the track leads: Sparked serves the ballots, https://fhir.hl7.org.au/aucore/fhir/DEFAULT serves the stable releases. Make sure each track page links the right server, and that every track whose IG Sparked does not serve is in `not_on_sparked`.
- [ ] Ask the HL7 AU test data maintainers whether an event tag of hl7au/au-fhir-test-data is planned (as for earlier events); if it is, record it in `data` of the manifest.
- [ ] Turn the previous event's loader banner off at loader.sparked-fhir.com until git sets it from `loader_banner`.

## Fri 27 Nov 2026 (T-11)

- [ ] **Smile node roll and AMQ fix (one-off; one day, any day of the week, since the Drifted budget opens daily 08:00 to 19:00 AEDT; one restart; before the sandbox scratch run below and any other bulk write, and by Mon 30 Nov at the latest, or Smile restarts at 12:29 AEDT on Thu 10 Dec).** The live NodeClaim `on-demand-prod-pr76v` was created 2026-11-10T01:29:08Z with `expireAfter: 720h` and expires 2026-12-10T01:29:08Z; disruption budgets cannot stop expiration in Karpenter v1. Separately, until aehrc/sparked-fhir-server-configuration#123 is applied, every resource write adds about 1.6 KB to a broker queue nothing drains, and Smile is evicted at about 65,000 messages, so the scratch run, the sandbox batch and any test-data reload wait for this item.
  1. Between 08:00 and 18:00 AEDT, merge aehrc/sparked-argo#384 (`on-demand-prod` `expireAfter: Never`). The node now counts as drifted, but the Drifted budget holds it until 19:00 AEDT.
  2. Confirm Argo synced it: `kubectl --context sparkey get nodepool on-demand-prod -o jsonpath='{.spec.template.spec.expireAfter}{"\n"}'` prints `Never`.
  3. Before 19:00 AEDT the same day, run the local Smile `terraform apply` of #123 (merged), and watch:
     ```sh
     kubectl --context sparkey get nodeclaims -l karpenter.sh/nodepool=on-demand-prod -w
     kubectl --context sparkey -n smile get pods -w
     curl -s -o /dev/null -w '%{http_code}\n' https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata
     ```
     The apply is a RollingUpdate (`maxSurge: 1, maxUnavailable: 0`) and a second Smile pod does not fit on the current node, so Karpenter launches a new node from the new template and the old pod serves until the new one is Ready. Expect one new NodeClaim, the new pod Ready, `200` throughout, then the old NodeClaim gone once empty: near-zero downtime (inferred, not observed). Nothing is left to drift at 19:00, so no evicting roll follows.
  4. Check: `kubectl --context sparkey get nodeclaims -l karpenter.sh/nodepool=on-demand-prod -o jsonpath='{.items[*].spec.expireAfter}{"\n"}'` prints `Never`.
  5. Do not reverse the order: an apply first and #384 later restarts Smile twice, the second time by eviction at 19:00 (about 7 to 10 minutes down). If #123 is not merged in time, merge #384 alone in the same slot: at 19:00 AEDT Karpenter launches the new node, then evicts the single pod (eviction ignores `maxSurge`), about 7 to 10 minutes down; announce it. Merged outside the slot, that roll starts within a few minutes of Argo's poll.
  6. If #384 is not merged by Mon 30 Nov, the fallback is a forceful roll at a chosen hour, `kubectl --context sparkey delete nodeclaim on-demand-prod-pr76v` (no pre-spun node, so a longer gap: node launch plus startup, up to the 20-minute startup probe ceiling), any time after 2026-11-11 17:00 AEDT so the new 30-day clock ends after the freeze. It is a cluster write: the operator's call. A #123 apply on its own also moves Smile to a fresh node whose 30 days end after the freeze, with no eviction.
- [ ] Sandbox service shown end to end on a scratch tenant: create, token, write, reset, expire. Then confirm the one source of the sandbox caps and dates, the ConfigMap in aehrc/sparked-argo `apps/sparked-sandbox/manifests/config.yaml` (#393), says what the manifest mirrors: `max_live` 30, `resource_ceiling` 10,000, `pool_target` 0, `sandboxes_expire` at the start of the expiry day (overnight from Thu 17 to Fri 18 Dec 2026 (AEDT)), and for web creations only `creates_per_ip_per_day` 60 and `pre_event.creates_per_ip_per_day` 3. If they differ, change the ConfigMap first (a sparked-argo PR), then copy its values to the manifest and re-render. Once Gate A is deployed, the cluster holds the same:
  ```sh
  kubectl --context sparkey -n sparked-sandbox get configmap sandbox-config -o jsonpath='{.data.config\.yaml}' \
    | grep -E '^ *(max_live|creates_per_ip_per_day|resource_ceiling|pool_target|sandboxes_expire):'
  ```

## Mon 30 Nov 2026 (T-8)

- [ ] Sandbox go/no-go. Set `sandbox.status` in the manifest to `open` (self-serve with the access code), `on-request` (the Sparked team issues sandboxes from a pre-made batch by Zulip direct message) or `cancelled`, re-render, open the PR.
- [ ] If sandboxes are on request: make the batch, after the Smile node roll and AMQ fix item (every sandbox write needs it), in the one register: the in-cluster register of aehrc/sparked-argo `apps/sparked-sandbox.yaml` Gate A, through a port-forward. Never in a register on a workstation: the expire and enforce CronJobs would never see those sandboxes.
  1. Gate A is deployed, with no web front:
     ```sh
     kubectl --context sparkey -n sparked-sandbox get statefulset,cronjob,deployment
     ```
     Expect StatefulSet `sandbox-postgres` 1/1, CronJobs `sandbox-expire`, `sandbox-enforce` and `sandbox-register-backup` with SUSPEND `False`, and no Deployment.
  2. In a dedicated terminal, in an aehrc/sparked-sandbox checkout of the reviewed commit (docs/runbook.md, operator-issued sandboxes):
     ```sh
     export SANDBOX_REGISTER=cluster   # the in-cluster register, through a port-forward
     source scripts/operator-env.sh    # the deployed engine principal, as the CronJobs use it; never changes it
     RUN_START="$(TZ=Australia/Melbourne date +%Y-%m-%dT%H:%M)"
     sandboxctl create --count 30 --batch 2026-12-melbourne --out-dir <a new directory outside any repository>
     ```
  3. The runbook's after-each-run check, then close:
     ```sh
     sandboxctl list --created-after "$RUN_START"   # every new sandbox active, DATA ready
     sandboxctl list --status provisioning,failed   # must list nothing
     sandboxctl reconcile                           # must report no orphan clients
     operator_env_close                             # stops the forwards, unsets the credentials; the principal stays enabled
     ```
     A sandbox in `provisioning` or `failed`, or `active` with DATA not `ready`: `sandboxctl expire <id>`, rerun until it prints `expired <id>`, then `sandboxctl create --count 1` with the same `--batch` for a replacement. An orphan client: `sandboxctl reconcile --fix`, as the runbook says.
  One 0600 JSON file per sandbox holds its credentials; the terminal shows only ids and FHIR bases. Keep a hand-out list of which sandbox id went to whom (never in a repository or a Zulip channel). `create` refuses to pass `max_live` (30), so with the batch issued, any further sandbox needs a free slot first.

## Tue 1 Dec 2026 (T-7)

- [ ] **Stacked PRs (one-off; read before merging the freeze PRs).** aehrc/sparked-argo keeps merged branches (`delete_branch_on_merge: false`), so GitHub does **not** retarget #383 and #386 when #382 merges. Merged as they stand they would land on the dead `freeze/event-sync-windows` branch, and after a squash of #382 they conflict. Right after #382 squash-merges, restack each one (whoever owns the #383 and #386 branches does this):
  ```sh
  # In an aehrc/sparked-argo checkout with a clean working tree:
  git fetch origin
  OLD=$(gh pr view 382 -R aehrc/sparked-argo --json headRefOid -q .headRefOid)   # #382's last head

  git switch freeze/karpenter-event-budgets && git merge --ff-only origin/freeze/karpenter-event-budgets   # #383
  git rebase --onto origin/main "$OLD"
  git push --force-with-lease origin freeze/karpenter-event-budgets
  gh pr edit 383 -R aehrc/sparked-argo --base main
  gh pr checks 383 -R aehrc/sparked-argo --watch           # wait for green before merging

  git switch freeze/renovate-pause && git merge --ff-only origin/freeze/renovate-pause                     # #386
  git rebase --onto origin/main "$OLD"
  git push --force-with-lease origin freeze/renovate-pause
  gh pr edit 386 -R aehrc/sparked-argo --base main
  gh pr checks 386 -R aehrc/sparked-argo --watch
  ```
  Tested 21 Nov on a simulated squash of #382: both rebases apply cleanly.
- [ ] **Freeze PRs (one-off setup; merge by Wed 2 Dec).** None acts on the cluster before Fri 4 Dec 2026, 17:00 AEDT, except that #383's business-hours budget is live on merge (it rolls no node).
  1. Argo CD sync windows: merge aehrc/sparked-argo#382 (deny windows plus `scripts/event-freeze.py`). Check:
     ```sh
     kubectl --context sparkey -n argocd get appproject inferno sparked -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.syncWindows[*].schedule} {.spec.syncWindows[*].timeZone} {.spec.syncWindows[*].duration}{"\n"}{end}'
     ```
     Expect `0 17 4 12 * Australia/Sydney 168h` for both.
  2. Karpenter budgets: after #382 merges, restack aehrc/sparked-argo#383 (the "Stacked PRs" item: rebase, force-push, `gh pr edit 383 --base main`, green), then merge it. Check:
     ```sh
     kubectl --context sparkey get nodepools -o custom-columns=NAME:.metadata.name,BUDGETS:.spec.disruption.budgets
     ```
     Expect on `on-demand` and `spot`: `nodes:1`, the `0 21 * * *` 11h budget, and the `0 6 4 12 *` 168h budget; `on-demand-overflow`: `nodes:1` and the `0 6 4 12 *` 168h budget (Underutilized, Drifted), no business-hours budget; `on-demand-prod`: the `0 6 4 12 *` 168h budget with no reasons; `spot-arm64`: the `0 21 * * *` budget. No NodeClaim should change.
  3. tx.dev preload overlay and Renovate pause: merge aehrc/sparked-argo#385 (the overlay, commented out; renders nothing new). After #382 merges, restack #386 (Renovate skips scheduled runs inside a rendered freeze; the "Stacked PRs" item: rebase, force-push, `gh pr edit 386 --base main`, green), then merge it. Check: `gh pr view 386 -R aehrc/sparked-argo --json baseRefName,state -q '.baseRefName+" "+.state'` prints `main MERGED`.

## Wed 2 Dec 2026 (T-6)

- [ ] **Inferno promotion (one-off; by Wed 2 Dec).** The promotion is the existing promotion PR, hl7au/au-fhir-inferno#223 (`infra/helm/inferno/values-prod.yaml` moves prod to the image staging already runs); a repository admin marks it ready and merges it. `inferno-prod` renders `master`, so Argo CD syncs it within minutes of the merge. If a trunk build closes #223 as superseded before then, merge the promotion PR that replaced it and point `inferno.release.tracking` in the manifest at that PR. Then run the check in the next item.
- [ ] Inferno: the current promotion PR (the manifest's `inferno.release.tracking` link, now https://github.com/hl7au/au-fhir-inferno/pull/223; repoint it first if a newer promotion PR has superseded that one) is merged. Check:
  ```sh
  kubectl --context sparkey -n argocd get app inferno-prod -o jsonpath='{.status.sync.status} {.status.health.status} {.status.sync.revision}{"\n"}'
  ```
  prints `Synced Healthy` and a `master` revision at or after that promotion PR's merge commit, and `https://inferno.hl7.org.au/suites/api/test_suites` lists every suite in the manifest at the manifest's kit versions. Then set `inferno.release.status: live` and re-render.
- [ ] Merge the rendered guide; check that https://sandbox.sparked-fhir.com accepts the access code (if the sandbox is open).
- [ ] If the sandbox is open or on request: run each Auth recipe in the guide verbatim against a sandbox (backend services, bearer token on each request, SMART App Launch with PKCE) and fix the guide where a step differs.
- [ ] If sandboxes are on request: in the Sparked FHIR Server topic on Zulip, say that sandboxes are issued on request and how to ask (in the topic or at the Sparked desk). Answer each request with a Zulip direct message to the person who asked, holding one batch file's credentials, and note the sandbox id against them in the hand-out list. Resets: `sandboxctl reset <id>`; a new backend secret: `sandboxctl rotate-secret <id> --out-dir <a new directory>`. Redirect URIs: `sandboxctl` sets them only at creation (`--redirect-uri`, repeatable) and cannot change an issued sandbox's, so whoever asks for them (first or later) gets a new sandbox with all their URIs: a new FHIR base URL, new credentials and fresh starter data. Free a slot under `max_live` first by expiring a batch sandbox nobody holds yet (the hand-out list says which; `sandboxctl expire <id>` until it prints `expired <id>`), then `sandboxctl create --count 1 --batch 2026-12-melbourne --redirect-uri <uri> --out-dir <a new directory>`; expire their old sandbox once they have moved over. Never post credentials in a Zulip channel.
- [ ] If the sandbox is open: send the event access code to the organisers for their pre-event message to registered participants. In the Sparked FHIR Server topic on Zulip, say that the code is in that message and that anyone without it can ask in the topic for a direct message; answer each request with a Zulip direct message to the person who asked. Never post the code in a Zulip channel (chat.fhir.org channels can be web-public, and the code exists to keep crawlers off the sandbox front), and never commit it.
- [ ] Loader banner: feed `loader_banner` to the loader's values and check https://loader.sparked-fhir.com/api/v1/public/event shows it.
- [ ] Post the guide link in the Sparked FHIR Server topic on Zulip and ask the track leads to link it from their track pages.

## Thu 3 Dec 2026 (T-5)

- [ ] **Last checks before the freeze.**
  1. NodeClaim ages: any node created between Wed 4 Nov 2026, 17:00 AEDT and Wed 11 Nov 2026, 17:00 AEDT expires inside the freeze.
     ```sh
     kubectl --context sparkey get nodeclaims -o custom-columns=NAME:.metadata.name,POOL:.metadata.labels.karpenter\\.sh/nodepool,CREATED:.metadata.creationTimestamp,EXPIRE:.spec.expireAfter
     ```
     Spot nodes usually go sooner; if one is still there, decide whether to roll it this evening (`kubectl delete nodeclaim <name>`, a cluster write).
  2. Ask whoever publishes to the `hl7au-dev` and `hl7au-fragments` syndication feeds to hold from Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT: a replica restart still runs the startup preload.
  3. Tell maintainers: no merges to aehrc/sparked-argo `main` and no Smile sync or `terraform apply` and no merges to this repository's `module-config/` or `deploy/` (a Smile sync renders `main`) from Fri 4 Dec 2026, 17:00 AEDT except emergencies; no Inferno promotion merges and no merges to hl7au/au-fhir-inferno `master` that change `infra/helm/inferno/` (prod renders `master`; the sync window holds them, but an emergency manual sync would ship them).
- [ ] NodeClaim ages, as seen on 21 Nov: two spot nodes were in that range, `spot-v5nwq` (loader, expires Sun 6 Dec 11:03 AEDT) and `spot-jdswt` (one of the two main-gateway Envoy proxies and one of the two ontoserver-gw proxies, expires Fri 11 Dec 08:58 AEDT). If either is still there, decide whether to roll it this evening.

## Fri 4 Dec 2026 (T-4)

- [ ] **Between 09:00 and 16:00: pause the tx.dev preload.** (After the freeze starts, the `ontoserver` sync window blocks the automated sync; a manual sync still works.)
  ```sh
  # In an aehrc/sparked-argo checkout:
  git fetch origin
  git worktree add -b freeze/tx-dev-preload-on ../tx-preload-on origin/main
  cd ../tx-preload-on
  sed -i '' 's|^          # - \$values/apps/ontoserver/values-event-freeze.yaml$|          - $values/apps/ontoserver/values-event-freeze.yaml|' apps/ontoserver.yaml
  git diff --stat   # 1 file, 1 line
  git commit -am "Pause tx.dev's nightly preload for the event freeze" && git push -u origin HEAD
  gh pr create --fill && gh pr merge --squash --delete-branch
  ```
  Both replicas roll one at a time (about 2.5 minutes each). Each roll runs the startup preload, so tx.dev's content is fixed at this switch, not when the freeze starts. If `ontoserver-statefulset-1` (rolled first) fails to start, Ontoserver rejected `"-"`: the roll stops with pod 0 still serving; revert the switch. Check:
  ```sh
  kubectl --context sparkey -n ontoserver get sts ontoserver-statefulset -o jsonpath='{.spec.template.spec.containers[?(@.name=="ontoserver-ontoserver")].env[?(@.name=="atom.preload.schedule.cron")].value}{"\n"}'   # prints -
  kubectl --context sparkey -n ontoserver get pods   # both Ready
  curl -s -o /dev/null -w '%{http_code}\n' 'https://tx.dev.hl7.org.au/fhir/CodeSystem/$validate-code?url=http://snomed.info/sct&code=38341003'   # 200
  ```
- [ ] Freeze starts at Fri 4 Dec 2026, 17:00 AEDT. Nothing to do at that moment: the Argo CD sync windows, Karpenter event budgets and Renovate skip all start on their own.
- [ ] **From five minutes after the freeze starts: confirm.**
  - Argo CD (v3.6.2 sets no Application condition when a window blocks auto-sync or self-heal; it logs it once per reconcile):
    ```sh
    kubectl --context sparkey -n argocd logs sts/argocd-application-controller --since=10m \
      | grep 'Sync prevented by sync window' | grep -c 'application=inferno-prod'   # more than 0
    ```
    Repeat the log grep with `application=ontoserver`, `application=smilecdr-routes` and `application=smilecdr` for the `sparked` project. In the Argo CD UI, each frozen Application's summary shows its sync window as Manual Allowed (Sync Allowed means no window is active). The `argocd` CLI's `--sso` login fails with `invalid_scope` (Keycloak's `argocd` client does not allow `offline_access`), so use the UI.
  - Karpenter: in Grafana Explore (Mimir), `karpenter_nodepools_allowed_disruptions{nodepool=~"on-demand|on-demand-prod|spot"}` drops to 0 for the frozen reasons.
  - Smile: the `smilecdr` Argo CD Application is in the `sparked` deny window (manual sync stays possible for an emergency); no `terraform apply` either (Aurora, IAM, secrets; convention).
  - Inferno: no promotion merge until the freeze ends. `inferno-prod` renders `master`, and the `inferno` sync window keeps it on the revision it had at the freeze start: the log grep above shows the window holding it.
- [ ] **During the freeze (keep for reference).**
  - Emergency change to a frozen app: merge the fix, then sync it by hand (the windows set `syncOverrun: true`, so no automated sync is left stuck from the freeze start to terminate first): Argo CD UI, the Application, Sync (allowed because every window sets `manualSync: true`). With kubectl only:
    ```sh
    kubectl --context sparkey -n argocd patch application <app> --type merge \
      -p '{"operation":{"initiatedBy":{"username":"<you>"},"sync":{"syncStrategy":{"hook":{}}}}}'
    ```
    For `smilecdr`, prune and keep `PruneLast`, or the superseded hashed ConfigMaps stay and the Application stays OutOfSync: `-p '{"operation":{"initiatedBy":{"username":"<you>"},"sync":{"prune":true,"syncOptions":["PruneLast=true"]}}}'`. In the UI, tick Prune; never Replace or Force.
  - Emergency Inferno rollback: revert the last promotion PR on hl7au/au-fhir-inferno `master` (a revert PR puts the previous image back in `infra/helm/inferno/values-prod.yaml`), merge it, then sync `inferno-prod` by hand. A manual sync ships everything on `master` since the freeze started, so check `git log` for `infra/helm/inferno/` first.
  - Emergency dependency bump: Actions, Renovate, Run workflow, tick `ignore_freeze`.
  - Emergency node repack: karpenter-config is not in a window; delete the event block from the NodePool and merge.
  - Lift the whole freeze early: merge `python3 scripts/event-freeze.py clear` (the clear step at the freeze end) and resume the tx.dev preload. Do not revert aehrc/sparked-argo#382 to lift it: once #386 is merged, that breaks every scheduled Renovate run. To remove the tooling, revert #386, then #383, then #382.
  - Renovate's scheduled runs inside the freeze should show as skipped: `gh run list -R aehrc/sparked-argo --workflow renovate.yaml -L 2`.

## Sat 5 Dec 2026 (T-3)

- [ ] **After 02:00 AEDT: Ontoserver logs show no `Commenced scheduled preload job`.** Each replica logs that line (`au.csiro.ontoserver.jobs.PreloadScheduler`) when the nightly cron fires at 15:00 UTC; the startup preload does not log it. Kubelet keeps only about two hours of Ontoserver logs, so ask Loki through the API server proxy (read-only):
  ```sh
  kubectl --context sparkey get --raw "/api/v1/namespaces/monitoring/services/lgtm-distributed-loki-gateway:80/proxy/loki/api/v1/query_range?query=%7Bnamespace%3D%22ontoserver%22%7D%20%7C%3D%20%22Commenced%20scheduled%20preload%20job%22&start=2026-12-04T14:55:00Z&end=2026-12-04T15:30:00Z&limit=10" | jq '[.data.result[].values[]] | length'
  ```
  Expect `0`. A normal night prints `2` (one per replica; checked for 19 and 20 Nov on 21 Nov). If it prints anything else, the cron is still on: check the freeze-start `kubectl get sts` output and sync `ontoserver` by hand.

## Mon 7 Dec 2026 (T-1)

- [ ] Run the smoke suite from CI; every status check green.
- [ ] Warm the validator: one `$validate?profile=<canonical>|<version>` per IG version in the version map on https://smile.sparked-fhir.com/aucore/fhir/DEFAULT.
- [ ] If the sandbox is open: print the guide with the access code (`EVENT_ACCESS_CODE=... python scripts/render_event.py --print-copy <file outside the repo> events/2026-12-melbourne.yaml`) and put the code on the venue slides. Never commit the code.
- [ ] Run `--check-links` once more.

## Tue 8 Dec 2026 (T)

- [ ] Each event morning: status checks, Inferno suite list, sandbox count against the cap of 30 live; watch the Zulip topics in the guide's Help section and answer access code and sandbox requests by direct message only; note problems for the retro.
- [ ] If sandboxes are on request, each event morning and evening (every event day): the CronJobs run against the register. `enforce` (every 15 minutes) suspends a sandbox over 10,000 resources; `expire` runs hourly at :37; the register backup at 01:07.
  ```sh
  kubectl --context sparkey -n sparked-sandbox get cronjob sandbox-enforce sandbox-expire sandbox-register-backup \
    -o custom-columns=NAME:.metadata.name,SUSPEND:.spec.suspend,LAST:.status.lastScheduleTime,SUCCESS:.status.lastSuccessfulTime
  kubectl --context sparkey -n sparked-sandbox get jobs --sort-by=.status.startTime \
    -o custom-columns=JOB:.metadata.name,START:.status.startTime,SUCCEEDED:.status.succeeded,FAILED:.status.failed
  ```
  Expect SUSPEND `false` for all three; for `sandbox-enforce`, LAST within the past 15 minutes and SUCCESS the same or one run earlier (times are UTC); for `sandbox-expire`, within the past hour; for the backup, after 01:07 today. In the jobs list, SUCCEEDED `1` and FAILED `<none>` on every finished job. A failed job: `kubectl --context sparkey -n sparked-sandbox logs job/<name>`. Sandboxes `enforce` suspended: in an operator shell (`export SANDBOX_REGISTER=cluster; source scripts/operator-env.sh`), `sandboxctl list --status suspended`; tell each holder, and `sandboxctl reset <id>` when they ask.

## Wed 9 Dec 2026 (T+1)

- [ ] Morning checks as on day 1.

## Thu 10 Dec 2026 (T+2)

- [ ] Morning checks as on day 1.
- [ ] Sandbox creation closes at Thu 10 Dec 2026, 17:00 AEDT; check the front refuses new sandboxes (open), or stop issuing from the batch (on request).

## Fri 11 Dec 2026 (T+3)

- [ ] Freeze ends at Fri 11 Dec 2026, 17:00 AEDT. Nothing to do at that moment: the sync windows and event budgets end on their own.
- [ ] **After the freeze ends: resume the tx.dev preload.** (Before then the window holds the sync.)
  ```sh
  # In an aehrc/sparked-argo checkout:
  git fetch origin
  git worktree add -b freeze/tx-dev-preload-off ../tx-preload-off origin/main
  cd ../tx-preload-off
  sed -i '' 's|^          - \$values/apps/ontoserver/values-event-freeze.yaml$|          # - $values/apps/ontoserver/values-event-freeze.yaml|' apps/ontoserver.yaml
  git commit -am "Resume tx.dev's nightly preload after the event freeze" && git push -u origin HEAD
  gh pr create --fill && gh pr merge --squash --delete-branch
  ```
  Check that the same `kubectl get sts` command as at the freeze start prints `0 0 15 * * *` and both pods are Ready.
- [ ] **Clear the rendered freeze blocks** (the crons recur next year otherwise; the sparked-argo render CI turns every PR red from the freeze end until this lands):
  ```sh
  # In an aehrc/sparked-argo checkout:
  git fetch origin
  git worktree add -b freeze/clear-2026-12-melbourne ../freeze-clear origin/main
  cd ../freeze-clear
  python3 scripts/event-freeze.py clear && python3 scripts/event-freeze.py check
  git commit -am "Clear the 2026-12-melbourne event freeze blocks" && git push -u origin HEAD
  gh pr create --fill
  ```
  Merge after review. Check: `kubectl --context sparkey -n argocd get appproject inferno sparked -o jsonpath='{.items[*].spec.syncWindows}'` prints nothing, and the NodePools lose the `0 6 4 12 *` budget (the business-hours budget stays).
- [ ] Tell maintainers the freeze is over and release the feed publishing hold. Renovate resumes on its own; work through its backlog one PR at a time. For the next event, run `python3 scripts/event-freeze.py render --manifest <raw URL of events/<event>.yaml>` in a sparked-argo worktree and merge that PR before its freeze (sparked-argo docs/event-freeze.md).
- [ ] Retro from the status history, the sandbox register and the Zulip topics.

## Fri 18 Dec 2026 (T+10)

- [ ] Sandbox expiry ran overnight from Thu 17 to Fri 18 Dec 2026 (AEDT): every event sandbox is disabled and its data deleted. If the sandbox was open: retire the access code. If sandboxes were on request, the `sandbox-expire` CronJob did it (hourly at :37; the first run after midnight disables every event sandbox, then clears them, about 2m20s each):
  1. The expire runs after midnight succeeded:
     ```sh
     kubectl --context sparkey -n sparked-sandbox get cronjob sandbox-expire \
       -o custom-columns=SUSPEND:.spec.suspend,LAST:.status.lastScheduleTime,SUCCESS:.status.lastSuccessfulTime
     kubectl --context sparkey -n sparked-sandbox get jobs --sort-by=.status.startTime \
       -o custom-columns=JOB:.metadata.name,START:.status.startTime,SUCCEEDED:.status.succeeded,FAILED:.status.failed
     ```
     Expect SUCCESS after midnight local time (times are UTC, so after 13:00 the previous day in AEDT), and no `sandbox-expire-*` job with FAILED set since then.
  2. Nothing is left, in an operator shell:
     ```sh
     export SANDBOX_REGISTER=cluster
     source scripts/operator-env.sh
     sandboxctl list --status pooled,provisioning,active,suspended,failed   # must list nothing
     sandboxctl list --status expired                                       # CLEARED yes on every row
     sandboxctl reconcile                                                   # must report no orphan clients
     operator_env_close
     ```
     A row with CLEARED `no`: the next hourly run retries it; check again after the next :37, and follow the runbook if it stays `no`. A sandbox still live: `sandboxctl expire <id>` until it prints `expired <id>`. Do not go on until every row says `yes`.
  3. Suspend the CronJobs: an aehrc/sparked-argo PR setting `suspend: true` on the `expire` and `enforce` entries of `cronJobs` in `apps/sparked-sandbox/values.yaml` (the freeze is over). After Argo CD syncs it, the first command in step 1 with `sandbox-enforce` added prints SUSPEND `true` for both, and no job of theirs is running.
  4. Disable the engine principal, in a new operator shell (as in step 2): `sandboxctl principal disable --pid <the sandbox-engine pid, aehrc/sparked-sandbox docs/live-check-2026-11.md>`, then `operator_env_close`. A minute or two later the engine credential no longer works on aucore: a new `source scripts/operator-env.sh` stops at "not ready".
  5. Delete the batch credential files and the hand-out list.
  Owner: the event operator; if they are away on this day, they name a stand-in before the event. Step 4 is not optional: the engine principal stays enabled on aucore until someone disables it.
- [ ] Turn the loader banner off; close this issue.
