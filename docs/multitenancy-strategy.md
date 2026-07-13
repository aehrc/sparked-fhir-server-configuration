# Multitenancy on the Sparked Dev FHIR Server: strategy paper

**Audience**: Sparked program team. **Companion documents**: [ADR 0001](adr/0001-partition-based-multitenancy.md) (the decision record) and the [rollout plan](multitenancy-rollout-plan.md) (the how and when).

## The problem we keep hitting

Every test event generates the same two requests:

1. **"Can we get write access?"** Especially from eRequesting participants: medications workflows are inherently write-heavy (create the MedicationRequest, claim the Task, update the status, post the result). Read-only access lets a vendor watch, not participate.
2. **"Can we load our own test data?"** Vendors arrive with curated datasets for their product demos and want to read them back reliably during the event.

Today everything lives in one shared dataset (the `DEFAULT` tenant). That forces a bad trade-off:

- If we grant write access, any participant can modify or delete the curated AU Core test data every other participant depends on. One stray `DELETE` or a badly built transaction Bundle degrades the event for everyone.
- If we do not, vendors cannot exercise the workflows they came to test, and custom data loading turns into "email the admins and hope".
- Either way, custom data mixed into the shared pool collides with other vendors' data and is wiped whenever we clear the server between events.

We have been splitting the difference with per-user read-only and read-write permission levels, which protects nothing (read-write users can still write over shared data) and satisfies nobody.

## The proposal in one paragraph

Give each vendor (or connectathon scenario) its own **tenant**: a private slice of the same server, with its own URL. The shared curated dataset stays where it is and becomes **read-only for everyone except admins**. A vendor gets full read/write inside their tenant and cannot touch anyone else's. Nothing else changes: same server, same IGs, same validation, same SMART auth, same terminology, zero new infrastructure.

```
https://smile.sparked-fhir.com/ereq/fhir/DEFAULT            shared curated data (read-only)
https://smile.sparked-fhir.com/ereq/fhir/VENDOR-ACME        Acme's sandbox (their read/write)
https://smile.sparked-fhir.com/ereq/fhir/SCENARIO-EREQ-MEDS medications track workspace
```

## Why this is cool for connectathons

- **eRequesting medications, actually end-to-end.** A scenario tenant can host the full placer/filler medications flow: participants create MedicationRequests, claim and update Tasks, post statuses, fire subscriptions, all with real writes, without any risk to the shared dataset. Multiple vendor pairs can run the same scenario in parallel tenants without tripping over each other's Tasks.
- **Bring-your-own test data.** A vendor loads their dataset into their tenant on day one and it is still there, untouched, on day three. Clearing between events becomes surgical: wipe scenario tenants, keep vendor tenants, never disturb `DEFAULT`.
- **The shared data finally becomes trustworthy.** `DEFAULT` turns into a stable, tamper-proof reference dataset. Demos and validation runs against it are reproducible because nobody can write to it.
- **Negative testing becomes safe.** Participants can test deletes, overwrites, and malformed updates in their own tenant. Today that class of testing is effectively banned.
- **Instant provisioning.** Creating a tenant is one admin API call. No restart, no deployment, no downtime, no effect on running traffic. We can provision a new vendor mid-event in under a minute.
- **Fits the existing service catalogue.** "Request a tenant" becomes a normal semi-automated offering, like SMART client registration is today.

## Why this is cool for Sparked beyond connectathons

- **Vendor evaluation sandboxes.** Long-running private workspaces for vendors building against AU Core / AU eRequesting, on infrastructure we already operate.
- **Parallel IG testing.** A tenant per test campaign (for example a draft IG's test data) that can be created and destroyed freely.
- **A governance story for write access.** Today "can I have write access" is a judgement call with shared blast radius. Under this model the answer is simply "yes, here is your tenant", and the blast radius is the requester's own data.

## Why the lift is small

This is the part that usually surprises people: **multitenancy is already switched on.** The server has run Smile CDR's URL-based tenant mode since day one; that is literally why every URL ends in `/DEFAULT`. Every user and client already carries a partition permission. What remains is:

1. Create partitions for tenants (runtime admin operation).
2. Register vendor users/clients scoped to their tenant instead of `DEFAULT` (a parameter change in scripts we already have).
3. Remove write permissions from the principals that can currently write to `DEFAULT` (config of existing users).
4. One small edit to the SMART post-authorize script so token context uses the right tenant URL.

No new modules, no interceptors, no schema changes, no data migration, no downtime.

## What it costs (honestly)

- **Tenant data must be self-contained.** A tenant cannot reference the shared `DEFAULT` patients by local reference (cross-partition references are blocked by design). Vendors load their own patient set, or we publish a copyable starter bundle. For scenario tenants this is arguably a feature: each run is hermetic.
- **Resource IDs are unique server-wide, not per tenant.** Two tenants cannot both hold `Patient/example` with client-assigned IDs. Tenant loads should use server-assigned IDs or a tenant prefix; the test-data tooling can do the prefixing.
- **Authenticated vendor sessions do not see `DEFAULT`.** Vendors read the shared data anonymously (it is public read today and stays that way). If a workflow ever genuinely needs one authenticated session spanning both, there is a documented one-script fallback (consent service), deferred until proven necessary.
- **No cross-tenant queries.** Admin sweeps iterate tenants one by one.
- **Ops must learn about ten lines of new runbook**: create tenant, grant tenant, clear tenant, delete tenant.

## What stays exactly the same

- All existing `DEFAULT` URLs, for every current client and script.
- Anonymous read of the shared data.
- IGs, profiles, validation, terminology: conformance resources are served to all tenants from one shared store, so every tenant validates against the same AU Core / eRequesting profiles automatically.
- SMART on FHIR auth flows and the registration process (with one added "tenant" field).
- Infrastructure, cost, monitoring, backup.

## Rollout at a glance

Staged one node at a time, rehearsal first, with an explicit go/no-go test matrix before any vendor is onboarded. `ereq` first (where the demand is), then `aucore`. `DEFAULT` becomes read-only only after tenants are proven working. Full detail, test matrix, and rollback story: [multitenancy-rollout-plan.md](multitenancy-rollout-plan.md).

## The ask

1. Review and approve [ADR 0001](adr/0001-partition-based-multitenancy.md) (DTR and Brett Esler are the deciders).
2. Nominate the first two or three vendors/scenarios for the `ereq` pilot.
3. After the pilot event, decide whether to promote the model to `aucore`.
