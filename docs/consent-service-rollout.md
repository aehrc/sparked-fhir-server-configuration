# Rolling out the read-only DEFAULT consent service

[ADR 0001](adr/0001-partition-based-multitenancy.md) says the shared `DEFAULT`
partition is readable by everyone and writable only by team curators. Smile CDR
cannot express that with permissions alone: `FHIR_ACCESS_PARTITION_NAME` gates
read and write together and there is no partition-scoped read-only variant, so a
tenant principal that needs an authenticated `DEFAULT` read has to be granted
`DEFAULT` outright, write included. `module-config/consent-default-readonly.js`
supplies the missing half by rejecting writes whose request partition is
`DEFAULT`.

The decision was taken in [#82](https://github.com/aehrc/sparked-fhir-server-configuration/pull/82).
This document covers shipping it.

## Why this is not just "deploy the script that was already there"

The script merged with the ADR was a reference implementation, and it did not
match Smile CDR's actual JavaScript consent API. Three defects, all of which
would have shown up on the node rather than in review:

**The callback signatures were wrong.** Smile CDR passes
`(theRequestDetails, theUserSession, theContextServices, theClientSession)`. The
reference implementation declared `(theRequestDetails, theContextServices)`, so
its `theContextServices` was really the user session and every
`theContextServices.proceed()` would have thrown. On the endpoint module that is
a failed request, on every request.

**Two callbacks were named wrong.** `canSeeResource` and `willSeeResource` are
`consentCanSeeResource` and `consentWillSeeResource`. As written they would never
have been called.

**`reject()` takes no message.** The reference implementation passed an
explanatory string that Smile CDR does not accept.

Source: [Consent Service: JavaScript API](https://smilecdr.com/docs/security/consent_service_javascript.html).
`scripts/test_consent_default_readonly.js` now pins the corrected behaviour, and
runs in CI.

## Where it is mounted, and why not persistence

On the **FHIR REST Endpoint** module (`fhir_endpoint`), not the persistence
module, even though Smile CDR supports both:

```yaml
consent_service.enabled: true
consent_service.script.file: "classpath:config_seeding/consent-default-readonly.js"
```

Package registry seeding and IG installs write `StructureDefinition`,
`ValueSet` and friends into `DEFAULT` at startup, below the REST layer. A
persistence mount would put this script in that path, where a rejection or a
script error means the node never becomes healthy, and the failure arrives on a
restart rather than on the apply that caused it. An endpoint mount cannot brick
startup. Participant traffic is all REST, so nothing that needs policing is
lost.

The trade is that anything writing `DEFAULT` below REST bypasses the check. That
is exactly the set of things we want exempt anyway.

## It ships in observe mode

`ENFORCE` in the script is `false`. In that state the script evaluates every
request, logs what it would have rejected, and rejects nothing. This exists
because one thing genuinely cannot be verified off the node: Smile CDR documents
the callback signatures but not the accessors on `RequestDetailsJson`, so
`getTenantId`, `getRestOperationType` and the URL fallbacks are probed
defensively at runtime rather than known to work. A partition the script cannot
resolve fails open with a warning, which is the same behaviour as not having the
script at all.

Observe mode is also how the curator exemption gets checked against real
traffic, including `sparked-test-data-loader`, which runs on the cluster and
writes the curated dataset over REST.

### Step 1: deploy in observe mode

Merging changes nothing on the server. Terraform is applied locally only
(`smile-application.yml` is disabled: plan output in a public repo leaks
infrastructure detail), so this needs a deliberate apply per
[terraform-local-deploy.md](terraform-local-deploy.md): snapshot Aurora, then

```bash
cd terraform
terraform init -backend-config=backend.hcl
terraform plan -out main.tfplan     # expect an in-place helm_release change, zero destroys
terraform apply main.tfplan
```

**The apply restarts the pod on its own.** The chart runs with `autoDeploy`
(its default, not overridden here), which suffixes ConfigMap names with a hash
of their content: the live node config is `smilecdr-scdrnode-aucore-<hash>` and
the mapped scripts are `smilecdr-scdr-<file>-<hash>`. The Deployment mounts them
by those exact names, so changing module config or adding a script renames the
ConfigMap, changes the pod template, and rolls the Deployment. Watch it rather
than triggering it:

```bash
kubectl --context sparkey -n smile rollout status deployment/smilecdr-scdrnode-aucore \
  --timeout=30m
```

The Deployment is `RollingUpdate` with `maxSurge: 1` and `maxUnavailable: 0`, so
the old pod keeps serving until the new one passes its readiness probe. Smile
CDR's startup probe allows up to 30 minutes, so allow for a slow boot rather
than assuming a hang.

If a rollout does not start, that means helm rendered an identical pod template,
which means the config change did not reach the release. Check the plan before
reaching for `kubectl rollout restart`, which would restart the pod without
applying anything new.

Two things about that restart are worth knowing before choosing a window, and
neither is specific to this change. This node runs `PROPERTIES_UNLOCKED`, so on
boot the properties file overwrites module config, and any console-only change
made to `aucore` since the last restart is reverted. And whatever else is
currently unapplied in the repo lands in the same apply, which is the reason to
read the plan rather than trust the resource count.

### Step 2: confirm the script loaded

```bash
kubectl --context sparkey -n smile logs -l app.kubernetes.io/name=smilecdr --tail=500 \
  | grep -i 'consent'
```

A module that cannot find or parse the script says so at startup. Silence here
plus a healthy pod means it loaded.

### Step 3: run the matrix

```bash
PHASE0_NODE=aucore ./scripts/multitenancy_phase0_tests.sh
```

`T10` is the consent case. It creates a user holding `MTTEST,DEFAULT`, which is
the grant shape ADR 0001 prescribes and the only one where this script is what
makes the difference (`T9`'s user is refused by authorization before consent is
consulted). Expected results:

| Check | Observe | Enforcing |
| --- | --- | --- |
| Authenticated `GET /DEFAULT/Patient` | 200 | 200 |
| Authenticated `POST /DEFAULT/Patient/_search` | 200 | 200 |
| Authenticated `POST /DEFAULT/Patient/$validate` | 200 | 200 |
| Participant `POST /DEFAULT/Patient` | 201 | **403** |
| Participant `POST /MTTEST/Patient` | 201 | 201 |
| Curator `POST /DEFAULT/Patient` | 201 | 201 |
| Anonymous `GET /DEFAULT/Patient` | 200 | 200 |

The POSTed search row is not padding. A FHIR search can arrive as `POST`, and
reading it as a write would break the authenticated `DEFAULT` read this whole
change exists to enable. The `$validate` row is there for the same reason and
was added after it turned out not to hold; see *Read-only extended operations*
below.

### Step 4: read the observe log

```bash
kubectl --context sparkey -n smile logs -l app.kubernetes.io/name=smilecdr --since=24h \
  | grep 'consent-default-readonly'
```

Two things to establish before enforcing:

- **The partition resolves.** Any `could not resolve the request partition` line
  means the accessors did not work on this build and the script is protecting
  nothing. Fix `resolvePartition` before going further.
- **No curator or loader traffic appears as `WOULD BE REJECTED`.** The line names
  the principal. If `sparked-test-data-loader` or an admin account shows up,
  enforcing would break the curated data pipeline, and
  `CURATOR_AUTHORITIES` in the script needs to match how that principal is
  actually provisioned.

Leave it here for at least one full data load. A quiet hour proves less than one
loader run.

### Step 5: enforce

Set `ENFORCE = true` in `module-config/consent-default-readonly.js`, apply, and
re-run the matrix expecting the enforcing column.

**Done 2026-08-19.** Observe mode ran on live `aucore` from the 03:40 deploy. The
gate was an `au-patient-summary` load through `loader.sparked-fhir.com` as
`ADMIN`: one create and eight deletes against `DEFAULT`, all succeeding, and the
consent service logged nothing for any of them, so the curator exemption holds.
Confirmed the service was still evaluating afterwards rather than silently
inert, by firing another anonymous `DEFAULT` write and watching a fresh
`WOULD BE REJECTED` line appear. Zero `could not resolve the request partition`
warnings and zero evaluation failures over the whole observe window.

Note for anyone reading the load output: the eight `422` bundle failures in that
run were profile validation errors on `au-ps-organization`, unrelated to this
service. Validation runs *before* the consent service, so those requests never
reached it.

## Read-only extended operations

The verb is not enough to tell a read from a write, and for the first three
weeks of enforcement this script assumed it was.

`isWrite` asked for the REST operation type, matched it against a list of reads
and a list of writes, and for anything else fell through to the HTTP verb, where
everything but `GET`, `HEAD` and `OPTIONS` counted as a write. An extended
operation lands in that fall-through. So did `$validate`, which FHIR defines as
a read: it runs the validator over a body the caller hands it and returns an
`OperationOutcome`, storing nothing. Arriving as a `POST`, it was classified as
a write to `DEFAULT` and rejected.

Measured on the live node on 2026-09-11, before the fix:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/metadata
# 200

curl -s -X POST -H 'Content-Type: application/fhir+json' \
  --data '{"resourceType":"Patient","id":"x"}' \
  https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient/'$validate'
# 403 {"resourceType":"OperationOutcome","issue":[{"severity":"error",
#      "code":"processing","diagnostics":"Rejected by consent service"}]}
```

Every anonymous and participant client hit it, which is the whole population
this partition exists for, and it took the "check against standards" feature in
the Platypus app out entirely
([aehrc/platypus#999](https://github.com/aehrc/platypus/issues/999)).

Worth recording because it cost time diagnosing: a `$validate` POST carrying an
*invalid* body returns `422`, not `403`, because the request-validating
interceptor runs before the consent service and answers first. A bare
`{"resourceType":"Observation"}` therefore looks like it works. Only a body that
passes validation reaches the consent service and shows the `403`.

`GET` extended operations were never affected, which is why `Patient/$summary`
has been serving the app all along. Note that a `403` on a `GET` extended
operation is a different thing entirely: `GET /DEFAULT/ValueSet/$expand` and
`GET /DEFAULT/Patient/<id>/$everything` answer `"Access denied"`, which is the
authorization layer's anonymous-access rules, not this script, whose refusal
always reads `"Rejected by consent service"`.

### The fix: classify by operation name, from an allowlist

An extended operation is a read or a write depending on which operation it is
and nothing else. `$expand` and `$expunge` arrive over the same verb at the same
operation type and differ only by name, so the name is what the script now asks
for, through the same defensive accessor probing the partition already uses
(`getOperation`, then `getOperationType`, then `getExtendedOperationName`,
normalised for case and for a leading `$` that a build may or may not include).

`READ_OPERATION_NAMES` is an **allowlist, not a denylist**, and the distinction
is the point. An operation absent from it is treated as a write. Smile CDR and
HAPI ship operations this node does not serve today, an IG install can add more,
and a later release can add one that writes; naming the writers instead would
mean every operation nobody thought of defaults to allowed, which is how the
curated dataset ends up edited by something that was never reviewed. The
conservative default the script shipped with is intact: an operation whose name
does not resolve, or resolves to something not on the list, is still judged by
its verb and a `POST` is still a write.

Allowed: `$validate`, `$expand`, `$lookup`, `$validate-code`, `$translate`,
`$subsumes`, `$everything`, `$summary`, `$docref`, `$meta`, `$graphql`, `$diff`,
`$last-n`, `$stats`, `$binary-access-read`.

Still rejected on `DEFAULT` for a non-curator, and each one because it writes:
`$expunge`, `$reindex`, `$mark-all-resources-for-reindexing`,
`$perform-reindexing-pass`, `$meta-add`, `$meta-delete`,
`$apply-codesystem-delta-add`, `$apply-codesystem-delta-remove`, the
`$partition-management-*` family, `$import`, `$export` (which writes a bulk
job), `$process-message`, `$submit-data`, and anything not listed at all.

Three smaller changes ride along. `VALIDATE` joins `READ_OPERATIONS`, because
HAPI gives `$validate` its own operation type rather than folding it in with the
extended operations, and on a build that reports it that way the name check is
never reached. `META_ADD` and `META_DELETE` join `WRITE_OPERATIONS` for the
mirror-image reason: they have their own types too, and naming them means a
build that reports the type catches them without the name check ever running, so
`$meta` being an allowed read can never be confused with its two writing
siblings. And the operation type is now folded for case *and* for hyphens, so a
build reporting the wire code (`search-type`) is read the same as one reporting
the enum constant (`SEARCH_TYPE`); the build running today reports the constant,
which is the only reason the POSTed-search exemption has been working.

The ordering matters and is tested: the name is consulted only after
`WRITE_OPERATIONS` has had its say, so a request whose operation type already
says `CREATE` stays a write whatever name arrives with it. The allowlist can
exempt a request the operation type left undecided; it can never overturn a
write the type identified.

`scripts/test_consent_default_readonly.js` covers all of this, including the
rows that must still be rejected, and runs in CI.

## Rollback

Set `consent_service.enabled: false` on the `fhir_endpoint` module and apply.
That is one key and it takes the script out of the request path entirely.
Reverting `ENFORCE` to `false` is the softer option and keeps the logging.

Both go through the same route as the deploy: apply, and the content-hashed
ConfigMap rolls the pod. `values-sparkey.yaml` sets `database: false`, so this
node runs `PROPERTIES_UNLOCKED` and the properties file is re-read and
overwrites module config on every boot. That is what makes a config-only change
take effect at all; in `DATABASE` mode these keys would be ignored on an
existing node.

Nothing here can be rolled back over the admin API. A console change to
`consent_service.enabled` would be reverted by the properties file on the next
restart, so the rollback has to go through git and an apply.

## Known limitations

**A rejected write returns a bare 403.** `reject()` accepts no message, so the
reason exists only in the server log. A participant sees a 403 with no
explanation of which partition refused them or why. If that becomes a support
burden, the alternative is to stop granting `<TENANT>,DEFAULT` and let
authorization refuse the request instead, which produces Smile CDR's own message
but also removes the authenticated `DEFAULT` read.

**Unresolvable partitions fail open.** Deliberate. Failing closed on an accessor
that did not resolve would reject every write on every tenant, including the
loaders. Failing open restores the pre-existing behaviour and logs a warning.
The consequence is that a build change that breaks the accessors silently
disables enforcement, which is why step 4 checks for that line explicitly.

**Existing accounts still hold write on DEFAULT.** Enforcing changes what they
can do, not what they are granted. As of this change:

- `platypus-demo-patient` is `read-write` on `PLATYPUS,DEFAULT`.
- `connectathon-user-05` and `connectathon-user-06` are `read-write` with no
  tenant set, which resolves to `DEFAULT`. Whether those accounts still exist on
  the server is unconfirmed; the connectathon *clients* are already gone, and
  `module-config/connectathon-clients.json` is drifted from the live node.

What stops those accounts writing the curated dataset today is that the clients
they log in through hold read-only scopes. That is a scope string away from
being a real hole, and it is the reason for shipping this rather than leaving it
on the shelf.

**A new read-only operation has to be added to the allowlist by hand.** Serving
one that is not in `READ_OPERATION_NAMES` means participants get a bare 403 on
`DEFAULT` for something that only reads, and the symptom looks like an
authorization problem rather than a consent one. That is the cost of an
allowlist and it is the right way round, but it makes the list something to
check whenever a new operation is enabled on `aucore`.

**Backend service clients are covered, users are not fully.** `FHIR_ALL_DELETE`
is now granted alongside write by `register_smart_client.py`, but
`manage_smart_users.py` still has no delete authority at all, so read-write
*users* cannot delete anything. That is a separate gap, tracked in
[#95](https://github.com/aehrc/sparked-fhir-server-configuration/issues/95)'s
follow-up discussion, and enforcing this consent service does not change it.
