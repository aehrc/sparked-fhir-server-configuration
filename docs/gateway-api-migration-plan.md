# Gateway API migration plan (nginx-ingress to Envoy Gateway)

Migrate `smile.sparked-fhir.com` from ingress-nginx to the Kubernetes Gateway API, served
by **Envoy Gateway**, matching the pattern already proven on the sibling `sparkey` cluster
(`sparked-argo`). This is the follow-up flagged in `docs/smilecdr-2026.05-upgrade-plan.md`.

## Decision: Envoy Gateway, not aws-lbc-gwapi

The original investigation scoped the chart's `aws-lbc-gwapi` (AWS LBC ALB) ingress type.
We chose the **Envoy Gateway** pattern instead, to align smile with sparkey and the
consolidation direction. Consequences of that choice:

- **No AWS LBC upgrade.** The ALB path needed AWS LBC >= v2.14 (the cluster runs v2.7.1);
  Envoy Gateway brings its own controller, so that blocker disappears entirely.
- **TLS terminates at Envoy** from a cert-manager Secret (Let's Encrypt), not at an ACM cert
  on the load balancer.
- **Routing is authored in GitOps**, not rendered by the smilecdr chart (see below).
- **DNS stays Terraform-managed** in this repo (chosen over external-dns): the
  `smile.sparked-fhir.com` alias is repointed to the Envoy NLB at cutover.

Three things are forced to differ from a pure sparkey copy ("where possible"):

1. **The smilecdr chart cannot render the route.** Its `aws-lbc-gwapi` type also emits an
   AWS-LBC `TargetGroupConfiguration` (`gateway.k8s.aws`, meaningless to Envoy and needing
   the newer LBC). So the chart's ingress is disabled and the HTTPRoutes are authored in
   `sparked-smile-argo` (sparkey's "app owns its route" model).
2. **DNS-01, not HTTP-01, for the cert.** Sparkey uses HTTP-01 because its DNS already points
   at its gateway; smile's DNS stays on the nginx NLB until cutover, so the cert is issued via
   a DNS-01 (Route53) solver, which needs no traffic path.
3. **No external-dns on smile.** Only sparkey runs it; smile keeps the Terraform-managed
   Route53 record.

## Scope split

| Layer | Repo | Owns |
|---|---|---|
| Gateway data plane + routing | `aehrc/sparked-smile-argo` (GitOps) | Envoy Gateway app, `GatewayClass`/`Gateway`/`EnvoyProxy`, cert-manager `Certificate` + DNS-01 solver, the smilecdr `HTTPRoute`s |
| App + DNS cutover | `aehrc/sparked-fhir-server-configuration` (this repo, `terraform/`) | disabling the chart ingress, repointing the Route53 alias, smoke tests |
| Cluster addons | `aehrc/sparked-infrastructure` (`smilecdr/smile-eks`) | decommissioning ingress-nginx after the soak |

## Current state (verified live, 2026-07-14)

Cluster `sparked-smilecdr`, context `sparked-smile`.

- **DNS**: Route53 zone `Z0504962FYWBFPBGHHE3`; `smile.sparked-fhir.com` is an `A`/ALIAS to the
  ingress-nginx NLB, created by this repo's `sdh-deps` module
  (`ingress_config.public.route53_create_record = true`).
- **TLS today**: terminates at that NLB via ACM cert `...0ee1e470...` (single SAN), then
  re-encrypts to nginx. This ACM cert is not reused by the Envoy path.
- **Ingress today**: chart-rendered `Ingress smilecdr-scdr-default` (class `nginx`, 18 paths).
- **Already present**: Gateway API CRDs (`v1.3.0` experimental, via the `gateway-api-crds`
  Argo app); cert-manager + `letsencrypt-prod` ClusterIssuer (live, already issuing
  Let's Encrypt certs), whose IRSA role already carries Route53 permissions (so DNS-01 needs
  no infra change); AWS LBC v2.7.1 (used only to provision NLBs from `LoadBalancer` Services,
  which is all the Envoy NLB needs).
- **Not present**: Envoy Gateway (its Argo app was staged in `sparked-smile-argo` but excluded
  as "unused"), any `Gateway`/`GatewayClass`, external-dns.

## Phased plan

Each phase is independently revertible. Phase 1 is additive and does not touch live traffic;
nginx keeps serving `smile.sparked-fhir.com` until the Phase 3 DNS flip.

### Phase 0: preparation (no changes)

1. Baseline the smoke suite: `./scripts/upgrade_smoke_tests.sh -o baseline-gwapi.md` (all
   green except the known hl7au smartauth 404).
2. Add a `--connect-to <nlb-dns>` option to `scripts/upgrade_smoke_tests.sh` so it can target
   the Envoy NLB by its own DNS name while keeping SNI and `Host` as `smile.sparked-fhir.com`
   (both the cert and the HTTPRoute match that host). This is the only change to this repo's
   scripts and is what enables side-by-side verification.

### Phase 1: stand up Envoy Gateway (GitOps) - DONE / in review

`sparked-smile-argo` PR #5 adds the whole data plane, additively:

- Envoy Gateway control plane (`gateway-helm`), re-included in `common-apps`.
- `EnvoyProxy` (internet-facing NLB, PROXY protocol, two spread replicas), `GatewayClass eg`,
  `Gateway main-gateway` with an HTTPS listener for `smile.sparked-fhir.com` and an
  HTTP->HTTPS redirect.
- cert-manager `Certificate smile-gateway-cert` + a DNS-01 (Route53) solver on
  `letsencrypt-prod` scoped to `smile.sparked-fhir.com`.
- Per-node `HTTPRoute`s (aucore/ereq/hl7au) in the `smile` namespace, mirroring the previous
  Ingress paths/ports (split per node: Gateway API caps one HTTPRoute at 16 rules).

Merging this syncs Envoy + the Gateway + routes, and issues the cert, but nothing is served
publicly yet (DNS still on nginx). ArgoCD only syncs `main`, so the feature branch is inert
until merge.

- Verify after merge: `kubectl get gateway -n default main-gateway` is `PROGRAMMED=True` with
  an NLB address; `kubectl get certificate -n default smile-gateway-cert` is `READY`; the
  three HTTPRoutes show `Accepted`/`ResolvedRefs` on the Gateway.
- Rollback: revert PR #5 (Argo prunes the Gateway/Envoy/routes). Live traffic never moved.

### Phase 2: verify the Envoy path on its own NLB hostname

With the Gateway programmed, test end to end before touching DNS. Get the Envoy NLB DNS name
(`kubectl get svc -n envoy-gateway-system` for the Gateway's LoadBalancer Service) and run
`./scripts/upgrade_smoke_tests.sh --connect-to <nlb-dns> -o phase2-envoy.md`, comparing to
baseline (30 pass, 1 known hl7au failure). This exercises all 18 paths, SMART/OIDC discovery,
counts, `$validate`, the ~3 MiB body check, and `$summary` against Envoy while prod DNS still
points at nginx.

- Watch the ~3 MiB body check specifically: nginx used `proxy-body-size: 16m`; if Envoy's
  default request limit rejects it, add a `ClientTrafficPolicy`/`BackendTrafficPolicy` raising
  the limit in `sparked-smile-argo` and re-verify.
- Rollback: nothing to roll back; no live change yet.

### Phase 3: flip DNS to the Envoy NLB (this repo)

Repoint `smile.sparked-fhir.com` from the nginx NLB to the Envoy NLB and stop the chart
rendering its Ingress. In this repo's Terraform:

- Disable the chart's ingress so `Ingress smilecdr-scdr-default` is removed (set the
  `ingress_config.public` entry to not create an ingress / drop it; the module then renders
  `ingresses.default = { enabled = false }`), and stop the module creating the Route53 record
  (`route53_create_record = false`, or remove the entry).
- Add a Terraform `aws_route53_record` (A/ALIAS) for `smile.sparked-fhir.com` pointing at the
  Envoy NLB, discovered via a `data` lookup of the Gateway's LoadBalancer Service in
  `envoy-gateway-system`.

- Verify: `./scripts/upgrade_smoke_tests.sh -o phase3.md` (default BASE, now resolving to the
  Envoy NLB) matches baseline; TLS presents the Let's Encrypt cert; `/aucore/console` loads.
- Rollback: revert this repo's change; the alias returns to the nginx NLB and the chart
  re-creates its Ingress. The Envoy stack (PR #5) stays up, so re-cutover is just re-applying.
  This is why ingress-nginx stays installed until Phase 4.

### Phase 4: decommission ingress-nginx (infra repo, after a soak)

After the Envoy path has served production for an agreed soak (suggest at least one
connectathon cycle), set `enable_ingress_nginx = false` in
`sparked-infrastructure/smilecdr/smile-eks` (mirroring `sparkey-eks`) and apply. Rollback
re-enables it (a fresh NLB with a new DNS name), so gate this phase accordingly.

## Verification

Reuse `scripts/upgrade_smoke_tests.sh` throughout; the only change is the additive
`--connect-to` flag. Baseline (nginx) -> Phase 2 (`--connect-to` the Envoy NLB, DNS unchanged)
-> Phase 3 (real DNS on Envoy). Per phase, also check `kubectl get gateway/httproute`,
Certificate readiness, and the browser console.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| DNS-01 cert fails to issue (Route53 perms/propagation) | Low | Envoy HTTPS listener has no cert, serves nothing | cert-manager IRSA already has the Route53 actions (verified). Confirm `Certificate` READY in Phase 1 before proceeding |
| Envoy rejects large FHIR bundles (no `proxy-body-size` equivalent by default) | Medium | ~3 MiB `$validate`/transaction bundles return an error | Phase 2 body check catches it; add a `ClientTrafficPolicy` raising the request limit if needed |
| ArgoCD applies `EnvoyProxy`/GatewayClass before the Envoy CRDs exist | Low | Transient sync error on first apply | The Envoy app carries sync-wave `-1`; ArgoCD `selfHeal`/retry converges. Cosmetic only |
| PROXY protocol mismatch (NLB sends v2, Envoy must expect it) | Low | Connections reset at Envoy | The `EnvoyProxy` sets the NLB `proxy-protocol` annotation and a `ClientTrafficPolicy` enables PROXY on the Gateway, matching sparkey |
| TLS 1.2-only client cannot negotiate | Low | A legacy client fails after cutover | Let's Encrypt certs + Envoy defaults support TLS 1.2/1.3; the current NLB is TLS 1.1, so this is a security improvement. Verify representative clients in Phase 2 |
| Route53 alias repoint has a propagation gap | Low | Seconds of stale routing at cutover | Alias records have a short effective TTL; both NLBs serve the same host during the window (cert on both paths) |

## Out of scope / follow-ups

- Cluster consolidation onto `sparkey` (this migration aligns smile toward it but does not do
  it). Note the two clusters overlap on VPC CIDR `10.0.0.0/16`.
- Retiring the ACM cert once the Envoy path is the only path.
- Whether to later adopt external-dns for smile (sparkey pattern) instead of the
  Terraform-managed record.
