# Cutover runbook: move smile.sparked-fhir.com to sparkey

Moves production traffic from the dedicated `sparked-smilecdr` cluster to the
parallel deployment on `sparkey`. The build is covered by
[sparkey-deploy-runbook.md](sparkey-deploy-runbook.md); this is the flip and the
decommission.

**Status: cut over 2026-08-03 07:22 UTC.** `smile.sparked-fhir.com` resolves to
sparkey's gateway and the smoke suite passes 11/11 through real DNS. What remains
is the soak and the decommission.

**The cutover was not one line**, which is what this runbook previously promised.
It took a chart fix (sparked-argo #226), the flag (#227), and a Route53 ownership
transfer that was not documented at all. The corrected sequence is below; the
sections that were wrong say so rather than being quietly overwritten, because
the same assumptions will show up in the next migration.

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
from the production HTTPRoutes.

**The flag alone does not move DNS, and did not.** It was necessary but not
sufficient, and this cost an hour on the day. See "Hand the record to
external-dns" below, which has to happen as well.

Prepared as sparked-argo #227, stacked on #226. Merge #226 first, then rebase
#227 onto main and merge it. With #226 in place the rendered diff of the flip is
that one annotation and nothing else, which is verifiable before merging:

```bash
diff <(git show main:charts/smilecdr-routes/values.yaml > /tmp/v.yaml; \
       helm template smilecdr-routes charts/smilecdr-routes -n smile -f /tmp/v.yaml) \
     <(helm template smilecdr-routes charts/smilecdr-routes -n smile)
```

Nothing else changes on the cluster. The listener, certificate, routes and body
limit are already in place, and the server has been advertising the production
FHIR base and OIDC issuer since it was built, so no config changes and no pod
restart.

### 3a. Hand the record to external-dns

`smile.sparked-fhir.com` was **not external-dns's record to repoint**. It was
created by the ORIGINAL deployment's terraform: `manage_ingress` defaults to
true, which sets `route53_create_record = true`, and the sdh-deps module creates
the alias to the old nginx NLB. sparkey's external-dns had no TXT ownership
record for it, so with `--registry=txt --policy=sync` it declined to touch it and
logged `All records are already up to date` every minute, with zero errors and no
mention of the hostname. The symptom is silence, not a failure.

Diagnosis, if this recurs: every hostname external-dns manages has a matching TXT
record in the zone. If a hostname has none, external-dns does not own it and will
never modify it, however correct the HTTPRoute is.

Two steps, in this order, so terraform relinquishes before external-dns takes
over. Both were done on 2026-08-03.

1. Drop the record from the OLD stack's state so terraform stops believing it
   owns it, and so a later `destroy` of that stack cannot take production DNS
   with it. The state bucket has versioning enabled, so this is recoverable.

   ```bash
   # separate working copy: do NOT re-init the sparkey worktree against prod
   terraform init -reconfigure -backend-config=backend.hcl   # infra/smile-app/prod.tfstate
   terraform state rm 'module.smile_cdr_dependencies.aws_route53_record.publicdns["public"]'
   ```

2. Seed TXT ownership records so external-dns adopts the existing alias and
   updates it **in place**. No delete, so no NXDOMAIN gap. Mirror the shape that
   already works for `smile-next` on this cluster: a `cname-` and an `aaaa-`
   prefixed TXT, value
   `"heritage=external-dns,external-dns/owner=default,external-dns/resource=httproute/smile/smilecdr-aucore-smile-sparked-fhir-com"`,
   TTL 300, applied with `aws route53 change-resource-record-sets`.

On the next sync external-dns logs the adoption explicitly, which is the signal
to watch for:

```
Desired change: UPSERT cname-smile.sparked-fhir.com TXT
Desired change: UPSERT smile.sparked-fhir.com A
Desired change: CREATE smile.sparked-fhir.com AAAA
3 record(s) were successfully updated
```

Note it also creates an AAAA, which the terraform-managed record never had.

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
- the served certificate is this cluster's, `CN=smile.sparked-fhir.com` issued by
  Let's Encrypt, not the old cluster's

### The first $validate after a restart returns 504

Running the smoke suite ~2 minutes after a pod restart fails on `$validate` with
HTTP 504. It is not a real failure and not caused by the OTel agent: the same
call five minutes later is HTTP 422 in 0.09s to 0.46s, consistently.

The cause is that readiness and usability are not the same thing here. The
readiness probe is `GET /aucore/fhir/endpoint-health` on 8000, which is cheap, so
the pod is marked Ready while the validation support chain and terminology caches
are still empty. The first `$validate` then has to warm all of that, including
remote terminology calls to `tx.dev.hl7.org.au`, and overruns the gateway
timeout.

Two consequences worth knowing:

- **Do not treat a post-restart smoke run as authoritative.** Give the server a
  few minutes, or re-run the one check.
- **Clients calling `$validate` in that window get a 504**, not a slow response.
  Restarts are not as transparent as the zero-downtime rollout implies.

Pre-existing, not introduced by the migration or the agent. Listed as a
follow-up below rather than fixed here.

### Config parity, checked after the cutover

`scripts/config_diff.py` compares runtime module config between the two servers.
Result on 2026-08-03: **3 real differences**, all intentional (137 further
differences suppressed as empty-vs-absent serialisation noise, and 20 modules
present only on the old server, which is the ereq/hl7au decommission).

The three are declarative IG package seeding, and the SMART post-authorize script
moving from an inline blob to a classpath file. The script was verified
byte-identical to the repo copy, so that pair is storage mechanism, not
behaviour.

### One capability did NOT survive: gender-identity search

Module config parity does not imply conformance-content parity, and this is the
case that proves it.

| | old | new |
|---|---|---|
| `GET /Patient?gender-identity=446141000124107` | 200, 3 patients | **400, unknown search parameter** |
| advertised in the CapabilityStatement | yes, 34 Patient params | no, 33 |

`http://hl7.org.au/fhir/SearchParameter/gender-identity` is an AU Base search
parameter. It is absent on sparkey because
`module-config/packages/package-au-base-6.1.1-draft.json` sets
`installMode: STORE_ONLY`, which registers the package without installing or
indexing its conformance resources. AU Core is `STORE_AND_INSTALL`, which is why
its search parameters did come through.

The old server never used `startup_installation_specs` at all (the option is
empty there); its packages were installed by hand over time, so it carries
fully-installed AU Base artifacts from an earlier version. The same history
explains its 800 StructureDefinition resources against 697 distinct canonical
URLs, and its 97 patients against 93. The profile SET is identical: 697 distinct
URLs on both, none unique to either side.

So this is legacy residue on the old server rather than something the current
declarative config ever produced. It is still an externally visible capability
difference, and the smoke suite does not exercise search parameters, so it would
not have been caught.

#### What AU Base actually contributes today: almost nothing

Checked on both servers before changing anything:

| | old | new |
|---|---|---|
| `au-patient` (an AU Base profile) | 0 | 0 |
| `au-core-patient` (AU Core) | 3 | 1 |
| AU Base SearchParameters present | 1 of 4 | 0 of 4 |

**Neither server has ever had AU Base conformance resources installed.** The old
server's entire AU Base footprint is the one `gender-identity` SearchParameter,
and it is version `4.2.2-ballot`, a far older AU Base than the 6.1.1-draft that
is seeded. Someone loaded it by hand. The other three AU Base search parameters
(`indigenous-status`, `encounter-discharge-disposition`,
`servicerequest-supporting-info`) return 400 on both servers.

#### Decision: install it (2026-08-03)

`STORE_AND_INSTALL` is therefore not a parity restore. It introduces roughly 159
resources AU Base has never contributed here (about 109 StructureDefinitions, 25
ValueSets, 21 CodeSystems, 4 SearchParameters), where parity needs exactly one.
Taken deliberately anyway, to have AU Base properly present rather than carrying
a hand-loaded relic of it.

Three things to know:

- **Not reversible by config.** Setting the flag back to `STORE_ONLY` does not
  uninstall what is already in the database. Recovery is an Aurora restore.
  Snapshot `<pre-aubase-install-snapshot>` was taken first.
- **No test bed exists.** `sparked-smile` and `sparked-smilecdr` are the same
  cluster, `dev.tfstate` is an abandoned stub, and the old cluster is the
  rollback target during the soak. This was applied straight to production.
- **`fetchDependencies: true` combined with install broke it on the first
  attempt.** Details below.

#### The first attempt failed: STORE_AND_INSTALL needs fetchDependencies false

Flipping `installMode` alone left `fetchDependencies: true`, and the persistence
module refused to start:

```
HAPI-1286: Error installing IG hl7.fhir.r4.core#4.0.1:
HAPI-0902: Can not create multiple ValueSet resources with ValueSet.url
"http://hl7.org/fhir/ValueSet/FHIR-version" and ValueSet.version "4.0.1",
already have one with resource ID: ValueSet/FHIR-version
```

`STORE_AND_INSTALL` with `fetchDependencies: true` installs the **dependency**
packages as well as the named one, so it tried to install `hl7.fhir.r4.core` and
collided with core resources already present from the AU Core install.

The pairing is the rule, and every other package here already followed it:

| installMode | fetchDependencies | packages |
|---|---|---|
| `STORE_AND_INSTALL` | `false` | au.core, au.ps, au.ereq |
| `STORE_ONLY` | `true` | uv.ips |

AU Base with install + fetch was the one combination never exercised. **If you
set `STORE_AND_INSTALL`, set `fetchDependencies: false` in the same edit.**

No production impact. `maxUnavailable: 0` kept the previous pod serving
throughout, the failed install aborted on its first ValueSet, and
StructureDefinition, SearchParameter and Patient counts were all still at their
pre-change values afterwards. Terraform sat waiting on the rollout until
`helm_chart_timeout` (1800s, `terraform/main.tf`) expired, then errored with
`context deadline exceeded` and left the release `failed`, which a later upgrade
handles without intervention.

#### Result of the corrected install

| | before | after |
|---|---|---|
| StructureDefinition | 697 | **806** (+109, the AU Base profiles) |
| SearchParameter | 1471 | **1475** (+4) |
| Patient | 93 | 93 |
| startup | 2m45s | ~5m |
| smoke suite | 11/11 | 11/11 |

**All four AU Base search parameters work** and are advertised in the
CapabilityStatement:

| resource | query | |
|---|---|---|
| Patient | `?gender-identity=` | 200 |
| Patient | `?indigenous-status=` | 200 |
| Encounter | `?discharge-disposition=` | 200 |
| ServiceRequest | `?supporting-info=` | 200 |

Patient now advertises 35 search parameters, against 33 before the install and 34
on the old server, so sparkey is ahead of what was lost.

> **Query by `code`, not by the URL suffix.** Two of these differ, and it is an
> easy way to convince yourself a search parameter is broken when it is fine:
> `.../SearchParameter/encounter-discharge-disposition` has
> `code: discharge-disposition`, and `.../servicerequest-supporting-info` has
> `code: supporting-info`. Only `gender-identity` and `indigenous-status` have a
> code matching their URL suffix.

#### Installing a SearchParameter does not index existing data. Reindex.

The dangerous half of this. Straight after the install every AU Base search
returned **HTTP 200 with `total: 0`**, while 25 patients demonstrably carried the
`individual-genderIdentity` extension. A search that 400s is obvious; one that
returns 200 and an empty bundle looks like "no matching data" and will be
believed.

Package-installed SearchParameters do not mark pre-existing resources for
reindexing, and nothing in the scheduled jobs picks them up. The index stays
empty until a reindex is run explicitly, per resource type:

```bash
POST /aucore/fhir/DEFAULT/$reindex
{"resourceType":"Parameters","parameter":[{"name":"url","valueString":"Patient?"}]}
```

Returns 202. It is a Batch2 job, so it queues: expect a few minutes before it
starts, not instant. Watch for `$reindex work chunk with N resources` in the pod
log, then re-run the search.

Reindexed on 2026-08-03 for every type the AU Base parameters target: Patient
(93), Encounter (26), Practitioner (378), PractitionerRole (362), RelatedPerson
(38), ServiceRequest (0). Verified afterwards against real data rather than by
status code:

| query | result | |
|---|---|---|
| `Patient?gender-identity=446141000124107` | 6 | old server returns 3, different AU Base version and expression |
| `Patient?indigenous-status=1` | 17 | was 0 before the reindex |
| `Encounter?discharge-disposition=9` | 1 | the only Encounter carrying the field |
| `ServiceRequest?supporting-info=` | 0 | correct, there are no ServiceRequest resources |

**Any future package install that adds SearchParameters needs the same reindex**,
and the verification has to be against known-matching data. Checking for a 200 is
not enough.

`$validate` returned 504 on the smoke run two minutes after the restart and 422
in 0.09s once warm, matching the pre-existing cold-start behaviour above rather
than anything the 109 new profiles introduced.

Two other search parameters also differ and are **not** a problem: the AU Core
canonicals `au-core-clinical-patient` and `au-core-practitionerrole-practitioner`
replace the base-FHIR `clinical-patient` and `PractitionerRole-practitioner` with
the same `code` and the same `base`, so the same searches work.

**Do not use telemetry as the end-to-end signal.** This runbook used to claim
OTLP data appearing in sparkey's Grafana would confirm the cutover. It does not
appear, and never did. The deployment sets every `OTEL_*` variable and carries
`instrumentation.opentelemetry.io/inject-java: "true"`, but the OTel operator
resolves that annotation against an `Instrumentation` CR in the pod's OWN
namespace and there is none in `smile`, so no agent is injected and nothing is
exported. The pod has no `opentelemetry-auto-instrumentation-java` init
container, which is the quick way to check.

This is not a regression: the old cluster had no `Instrumentation` CRs either, so
Smile CDR application telemetry was never flowing. Only cadvisor and
kube-state-metrics cover the namespace. Recorded as a follow-up below.

## Rollback

**Setting `publishDns: false` is no longer a rollback. It is an outage.** Now
that external-dns owns the record, removing the source makes it DELETE the record
under `--policy=sync`, rather than restore anything. external-dns has no
knowledge of the old cluster's load balancer and cannot put it back. The earlier
wording here was wrong on exactly the step you would reach for under pressure.

To roll back, put the alias back yourself, then stop external-dns fighting you:

1. UPSERT `smile.sparked-fhir.com` A back to the old cluster's nginx NLB,
   `k8s-ingressn-ingressn-f807c43cbc-ec2e8c167651c4d6.elb.ap-southeast-2.amazonaws.com`
   in hosted zone `ZCT6FZBF4DROD` (alias, `evaluate_target_health: false`).
   Recorded here because it is no longer in any terraform state; it also survives
   in `prod.tfstate` version history at serial 223.
2. Set `publishDns: false` in `charts/smilecdr-routes/values.yaml` so external-dns
   stops reconciling the hostname back to sparkey. Do this promptly: until it
   lands, external-dns will re-point the record on its next 1m sync.
3. Delete the `cname-smile` and `aaaa-smile` TXT records, and the AAAA record
   external-dns created, if you want the zone back to its pre-cutover shape.

Doing 2 before 1 is fine too and closes the racing window, at the cost of the
record being briefly absent. The old cluster serves throughout either way.

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

   The Route53 record was removed from that stack's state on 2026-08-03, so a
   destroy will no longer delete production DNS. Confirm before destroying, since
   this is the one mistake here that takes the service down and is slow to undo:

   ```bash
   terraform state list | grep route53_record   # expect no publicdns entry
   ```

   Losing the rollback target is the accepted consequence of this step. Do not
   start it while the rollback path above still matters.
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
| No Smile CDR application telemetry, on either cluster | fixed by sparked-argo #228, which adds the `Instrumentation` CR to `smile`. Needs one pod restart after it lands, since injection happens at admission. The `inject-java` annotation is a silent no-op without a CR in the pod's own namespace |
| `$validate` 504s for a few minutes after every restart | the readiness probe is a cheap health endpoint, so the pod is Ready long before the validation chain and terminology caches are warm. Either warm the validator during startup or gate readiness on it |
| Consolidate the `OTEL_*` env vars into the Instrumentation CR | they now duplicate it; needs a terraform apply, so do it deliberately rather than opportunistically |
| Convert sparkey's gateway from Classic ELB to NLB | legacy resource type fronting 19 hostnames |
| Activate cost-allocation tags | still pending with CSIRO IMT; blocks measuring the saving |
| CSIRO TLS-inspection CA lacks an Authority Key Identifier | breaks Python tooling; worth reporting to IMT |
