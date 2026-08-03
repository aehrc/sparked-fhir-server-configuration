# Cutover runbook: move smile.sparked-fhir.com to sparkey

Moves production traffic from the dedicated `sparked-smilecdr` cluster to the
parallel deployment on `sparkey`. The build is covered by
[sparkey-deploy-runbook.md](sparkey-deploy-runbook.md); this is the flip and the
decommission.

**The cutover itself is one line.** Everything else here is checking before and
after.

## Preconditions

All of these were true at 2026-08-03. Re-check rather than assume: the parallel
deployment may have sat for weeks.

| | Check |
|---|---|
| Acceptance gate green | `bash scripts/upgrade_smoke_tests.sh --connect-to <sparkey gateway LB> -o gate.md` returns 11/11 |
| DNS still on the old cluster | `dig +short smile.sparked-fhir.com` matches the old nginx NLB |
| Listener and cert live | `kubectl --context sparkey get certificate -n default smile-gateway-cert` Ready, Gateway shows 19/19 listeners Programmed |
| Pod healthy | one pod, `1/1`, no restart loop |
| Network policies validated | see below, and note the check this table used to name does not work |
| Route naming fix merged | sparked-argo #226 MUST land before the flip (see below) |
| Decommission PR merged | sparked-fhir-server-configuration #87, if ereq/hl7au are to stay off |

### Land the route-naming fix first

Until sparked-argo #226 is merged, the flip is not safe. The HTTPRoute name in
`charts/smilecdr-routes` was `smilecdr-<node>` plus an `-unpublished` suffix,
with the hostname absent, so it is unique only while exactly one hostname is
published. Setting `publishDns: true` on the second one renders two HTTPRoutes
with the same name in the same namespace, and duplicate `targetRefs` in the
BackendTrafficPolicy. The app is auto-sync with `prune: true` and client-side
apply, so the flip would either fail to sync or apply last-wins and silently
drop `smile-next.sparked-fhir.com`, taking its A record with it.

#226 derives the name from node plus hostname and makes it independent of
`publishDns`, which is also what makes the flip a pure annotation change rather
than a delete and recreate.

### The netpol check in this runbook was never valid

This runbook previously said to check `{log_type="netpol"}` in Loki. **There is
no `log_type` label in this Loki.** That query returns empty whatever the state
of the world, so a green result from it was never evidence.

There is no working deny signal in the observability stack today. The node agent
runs with `--enable-policy-event-logs=true` but `--enable-cloudwatch-logs=false`,
so policy events are written only to node-local disk at
`/var/log/aws-routed-eni/network-policy-agent.log`, and the only agent metric
scraped into Mimir is `awsnodeagent_policy_programming_latency_seconds`, which
says nothing about drops. To read denies today you have to go to the node
hosting the pod:

```bash
NODE=$(kubectl --context sparkey get pod -n smile -o jsonpath='{.items[0].spec.nodeName}')
kubectl --context sparkey debug node/$NODE -it --image=busybox:1.36 --profile=general -- \
  grep DENY /host/var/log/aws-routed-eni/network-policy-agent.log
```

**Fix this properly** by setting `--enable-cloudwatch-logs=true` on the
`aws-eks-nodeagent` container so policy events land somewhere queryable, then
restore a real check to this table.

### Why the flip is nonetheless not a netpol risk

Reviewed the policies directly in place of the log. Both hostnames attach to the
same `main-gateway` and are matched by the same ingress rule in
`network-policies/phase1-ingress/smile.yaml`: `from: envoy-gateway-system` on the
six container ports. Nothing in the policy set keys on hostname.

The DNS flip changes which address clients resolve, not the path traffic takes.
The acceptance gate run with `--connect-to` the gateway CLB therefore already
exercised the exact post-cutover ingress path. Egress is unaffected by how
clients arrive.

What that does not cover is a policy that is fine for gate traffic but wrong for
some real client pattern. Rolling back a policy is a one-file delete in
sparked-argo, so it stays cheap to fix.

## Cutover

### 1. Lower the TTL, in advance

The Route53 record is managed by external-dns. Lower its TTL a few hours ahead so
rollback propagates quickly. external-dns sets a default TTL unless annotated; if
it is high, add `external-dns.alpha.kubernetes.io/ttl` to the HTTPRoute in the
smilecdr-routes chart and let it reconcile before proceeding.

Checked 2026-08-03: the record is already at TTL 60, so there is nothing to do
here. Re-check with `dig smile.sparked-fhir.com A` rather than assuming.

### 2. Announce

Zulip and Confluence. Two things are worth saying explicitly:

- **SMART sessions will need re-authentication.** The new server signs tokens with
  a different key (`kid de533ef3-…` rather than the live `smilecdr-token-signing`).
  Clients re-fetch the JWKS automatically on an unknown `kid`, but access tokens
  issued before the flip stop validating.
- **Test data differs slightly.** 93 patients rather than 97. The difference is
  legacy data on the old server from dataset versions no longer in
  `hl7au/au-fhir-test-data`; the new server carries exactly the current set.

### 3. Flip

In `aehrc/sparked-argo`, `charts/smilecdr-routes/values.yaml`:

```yaml
hostnames:
  - name: smile-next.sparked-fhir.com
    publishDns: true
  - name: smile.sparked-fhir.com
    publishDns: false      # <- change to true
```

That removes the `external-dns.alpha.kubernetes.io/controller: "none"` annotation
from the production HTTPRoutes, and external-dns repoints the A record at
sparkey's gateway within its sync interval (1m).

Prepared as sparked-argo #227, stacked on #226. Merge #226 first, then rebase
#227 onto main and merge it. With #226 in place the rendered diff of the flip is
that one annotation and nothing else, which is verifiable before merging:

```bash
diff <(git show main:charts/smilecdr-routes/values.yaml > /tmp/v.yaml; \
       helm template smilecdr-routes charts/smilecdr-routes -n smile -f /tmp/v.yaml) \
     <(helm template smilecdr-routes charts/smilecdr-routes -n smile)
```

Nothing else changes. The listener, certificate, routes and body limit are
already in place, and the server has been advertising the production FHIR base
and OIDC issuer since it was built, so no config changes and no pod restart.

### 4. Watch it move

```bash
watch -n5 'dig +short smile.sparked-fhir.com'
```

It should change from the old nginx NLB addresses to sparkey's gateway. As at
2026-08-03 that is `13.211.53.144 / 3.104.201.43 / 13.55.220.98` moving to
`13.211.0.59 / 52.65.179.96`. Confirm the target set against
`dig +short <sparkey-gateway-clb>.ap-southeast-2.elb.amazonaws.com`
rather than the literals above, since the CLB's addresses can change.

### 5. Verify

```bash
bash scripts/upgrade_smoke_tests.sh -o post-cutover.md    # no --connect-to now
```

Expect the same 11/11, this time through real DNS. Also confirm:

- `curl -s https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata | jq .implementation.url`
  returns `https://smile.sparked-fhir.com/aucore/fhir`, not an internal address
- the OIDC issuer matches
- telemetry appears in sparkey's Grafana (the OTLP endpoint resolves identically
  on both clusters, so this needs no change and is a good end-to-end signal)

## Rollback

Set `publishDns: false` again. external-dns restores the record to the old
cluster's load balancer, which has been serving throughout and is untouched.

Rollback is lossless for reads. Any writes accepted by the new server between the
flip and the rollback stay only on the new server's Aurora, so keep the window
short and prefer flipping outside an event.

## After the soak

Two to four weeks is the suggested soak. Then, in order:

1. **Remove the smile-next hostname.** Drop its entry from
   `charts/smilecdr-routes/values.yaml`, and its listener and certificate from
   `apps/common/networking/gateway-infra.yaml`. Optionally drop
   `smile.sparked-fhir.com` from the DNS-01 selector in `cluster-issuer.yaml`,
   since HTTP-01 works once DNS points at this cluster.
2. **Destroy the old app deployment**, then `smilecdr/smile-eks`. Take a final
   Aurora snapshot first and retain it.
3. **Archive `aehrc/sparked-smile-argo`.** Its Envoy config and smilecdr-routes
   chart have moved to sparked-argo; its dashboards should move to sparkey's
   Grafana before this.
4. **Remove `smilecdr/` from sparked-infrastructure** and close the phase 4
   re-CIDR item as superseded.
5. **Delete the orphaned Classic ELB** `a461e4fb43cdd45fba222e1e4dd0e9c5` in the
   old VPC if it has not gone with the cluster. It has zero registered instances
   and is roughly $20/mo of nothing.

## Things to fix that this migration surfaced but did not fix

Not cutover blockers. Listed so they are not lost.

| Item | Where |
|---|---|
| Promote `startupProbe` 1200s to `values-common.yaml` | the live deployment has the same 300s budget and would restart-loop on any cold start |
| Review `allow_multiple_delete` and `auto_create_placeholder_reference_targets` | carried as `true` for parity; both loosen the server |
| Tighten `password_pattern` from `.{4,100}` | carried verbatim from live; four characters on a public server |
| `smart-post-authorize.js` findings | [smart-post-authorize-review.md](smart-post-authorize-review.md), especially the client-suppliable `launch` parameter |
| Loader transaction mode omits `fullUrl` | `scripts/load_test_data.py`; makes transaction mode unusable |
| 48 test resources reference AU eRequesting profiles | neither server has them; exclude from aucore loads |
| Ship network-policy deny events somewhere queryable | `--enable-cloudwatch-logs=true` on `aws-eks-nodeagent`; today they are node-local only, which is why this runbook's Loki check was silently vacuous |
| Convert sparkey's gateway from Classic ELB to NLB | legacy resource type fronting 19 hostnames |
| Activate cost-allocation tags | still pending with CSIRO IMT; blocks measuring the saving |
| CSIRO TLS-inspection CA lacks an Authority Key Identifier | breaks Python tooling; worth reporting to IMT |
