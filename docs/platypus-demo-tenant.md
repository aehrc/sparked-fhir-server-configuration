# The Platypus demo tenant on `aucore`

Platypus Health is a patient-held personal health record app that connects to
this server as a SMART App Launch client. It uses two partitions on the `aucore`
node, for different reasons, and the split is easy to get wrong.

| Partition | What Platypus uses it for | Writable |
| --- | --- | --- |
| `DEFAULT` | The curated AU Core dataset it reads as a patient's clinical history, and the shared conformance resources (`Questionnaire`, `StructureDefinition`, `ValueSet`, `CodeSystem`) every tenant needs | No, by design (ADR 0001) |
| `PLATYPUS` (partition 102) | Anything the demo needs to WRITE: patient-contributed observations, form responses, seeded scenario data | Yes |

## What is seeded from this repository, and what is not

Seeded from here:

- `module-config/platypus-clients.json` — the `platypus-health` SMART client.
- `module-config/platypus-users.json` — the `platypus-demo-patient` user.

```bash
python scripts/register_smart_client.py --bulk \
  --clients-file module-config/platypus-clients.json --node aucore
python scripts/manage_smart_users.py --bulk \
  --users-file module-config/platypus-users.json --node aucore
```

Both are idempotent: run them against the live node and existing records are
skipped, not overwritten. That makes them safe as a verification step as well as
a seeding step.

**Not seeded from here:**

- **The `PLATYPUS` partition itself.** It is created through the admin JSON API,
  like every other partition on this server. Partition creation is not currently
  expressed in this repository for any tenant, so making an exception for one
  would be misleading.
- **Test data.** The tenant is deliberately empty of clinical resources at rest.
  What belongs in it depends on the scenario being demonstrated, so it is loaded
  as an operational act (see `aehrc/sparked-test-data-loader`), not held here.

## Why this user has a `DEFAULT` grant, when ADR 0001 says vendor tenants should not

`platypus-demo-patient` carries `FHIR_ACCESS_PARTITION_NAME PLATYPUS,DEFAULT`.
That is a deliberate exception to the tenant-scoping ADR 0001 describes, and it
exists because of one concrete failure.

Writing a `QuestionnaireResponse` to `PLATYPUS` was rejected with *"User does not
have access to Questionnaire resources on the requested partition"*. Smile CDR
authorises the write against the referenced `Questionnaire` type, and
conformance/definitional resources live in the shared `DEFAULT` partition rather
than in each tenant. A tenant-only session therefore cannot write a resource that
references a shared conformance resource at all.

Granting the `DEFAULT` read is the pragmatic fix, and it grants nothing new in
practice: `DEFAULT` is already anonymously readable, so the session can reach
nothing it could not have reached unauthenticated. It stays write-protected.

The cleaner fix would be for the server not to require local access to a
referenced `Questionnaire` — real `QuestionnaireResponse` resources routinely
reference a questionnaire hosted elsewhere. That is a design question for the
Sparked team rather than something to settle in a tenant's config.

## The scope set is read-only, and that may be wrong

The live `platypus-health` registration carries `patient/*.read` and no write
scope. The client files here record that, because seeding a scope set the server
does not have would be worse than recording the truth.

Platypus's own notes say a granular vitals write scope
(`patient/Observation.c?category=vital-signs`) was applied to this client through
the admin JSON API in July 2026, because `register_smart_client.py --scopes` did
not take effect under `--update-existing`. That scope is not on the server today.
Either it was reverted deliberately or it was lost, and **that should be
established before it is added back here** — the app's write demos target the
`ereq` node's `PLATYPUS` tenant, so a read-only `aucore` client may well be
correct.

If `--scopes` still does not apply on `--update-existing`, that is a bug in
`register_smart_client.py` worth its own issue: it makes the seed file a
statement of intent rather than a source of truth.

## Launch context

The user's default launch context is `Patient/banks-mia-leanne`, the AU Core
sample patient in `DEFAULT`. Because tenant identification is URL-based, the
partition the app connects to decides which copy of that patient it resolves:
connecting to `.../aucore/fhir/DEFAULT` reads the curated one, and connecting to
`.../aucore/fhir/PLATYPUS` reads whatever copy has been seeded there. Seeding a
scenario into `PLATYPUS` therefore means seeding a `Patient` with that id first,
or the launch context resolves to nothing.
