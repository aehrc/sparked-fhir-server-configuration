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
| Network policies validated | no legitimate drops in `{log_type="netpol"}` in Loki (see below) |
| Decommission PR merged | sparked-fhir-server-configuration #87, if ereq/hl7au are to stay off |

### The one precondition still outstanding

Network policies for the `smile` namespace were written from the pod on the OLD
cluster, not observed on this one. They have not been validated against real
traffic. Before flipping, check the node-agent deny log in Grafana:

```
{log_type="netpol"} |= "smile"
```

Nothing legitimate should be dropping. Rolling back a policy is a one-file delete
in sparked-argo, so an over-tight rule is cheap to fix now and expensive to
discover at cutover.

## Cutover

### 1. Lower the TTL, in advance

The Route53 record is managed by external-dns. Lower its TTL a few hours ahead so
rollback propagates quickly. external-dns sets a default TTL unless annotated; if
it is high, add `external-dns.alpha.kubernetes.io/ttl` to the HTTPRoute in the
smilecdr-routes chart and let it reconcile before proceeding.

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

Nothing else changes. The listener, certificate, routes and body limit are
already in place, and the server has been advertising the production FHIR base
and OIDC issuer since it was built, so no config changes and no pod restart.

### 4. Watch it move

```bash
watch -n5 'dig +short smile.sparked-fhir.com'
```

It should change from the old nginx NLB addresses to sparkey's gateway.

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
| Convert sparkey's gateway from Classic ELB to NLB | legacy resource type fronting 19 hostnames |
| Activate cost-allocation tags | still pending with CSIRO IMT; blocks measuring the saving |
| CSIRO TLS-inspection CA lacks an Authority Key Identifier | breaks Python tooling; worth reporting to IMT |
