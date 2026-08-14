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

Apply per [sparkey-deploy-runbook.md](sparkey-deploy-runbook.md). Nothing else
in this change alters runtime behaviour.

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
| Participant `POST /DEFAULT/Patient` | 201 | **403** |
| Participant `POST /MTTEST/Patient` | 201 | 201 |
| Curator `POST /DEFAULT/Patient` | 201 | 201 |
| Anonymous `GET /DEFAULT/Patient` | 200 | 200 |

The POSTed search row is not padding. A FHIR search can arrive as `POST`, and
reading it as a write would break the authenticated `DEFAULT` read this whole
change exists to enable.

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

## Rollback

Set `consent_service.enabled: false` on the `fhir_endpoint` module and apply.
That is one key and it takes the script out of the request path entirely.
Reverting `ENFORCE` to `false` is the softer option and keeps the logging.

Note that `config.database: true` means seeded properties apply on first boot
only, so a change to these keys against an existing node goes through the same
route as any other module config change; see
[smart-auth-config.md](smart-auth-config.md).

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

**Backend service clients are covered, users are not fully.** `FHIR_ALL_DELETE`
is now granted alongside write by `register_smart_client.py`, but
`manage_smart_users.py` still has no delete authority at all, so read-write
*users* cannot delete anything. That is a separate gap, tracked in
[#95](https://github.com/aehrc/sparked-fhir-server-configuration/issues/95)'s
follow-up discussion, and enforcing this consent service does not change it.
