# Multitenancy architecture review: workshop pre-paper

Pre-reading for the read/write multitenancy workshop. Companion documents:
[ADR 0001](adr/0001-partition-based-multitenancy.md) (decision record, awaiting sign-off),
[strategy paper](multitenancy-strategy.md) (motivation),
[rollout plan](multitenancy-rollout-plan.md) (phases, test results, execution log),
[demo walkthrough](multitenancy-demo.md) (live six-command demo).

- **Proposed attendees**: DTR, Brett Esler, Heath, Chitra
- **Decision sought**: endorse (or amend) ADR 0001 and the tenant visibility policy below, and approve the aucore rollout
- **Test node**: no standup required; the ereq node of the Sparked Dev FHIR Server is running the full pilot live, with a scripted demo and disposable tenants for hands-on exploration during the workshop

## 1. Where things stand

Multitenancy is live as a pilot on the `ereq` node. Partitioning was already enabled
on every node (URL-based tenant selection; the `/DEFAULT` segment in every endpoint URL),
so the pilot required no config file changes, no restarts, and no data migration:
tenants, users, and permissions are all runtime data. The pilot comprises two tenants
(a medications scenario workspace and a vendor sandbox), tenant-scoped demo users, a
completed placer/filler medications flow, and removal of participant write access to
the shared `DEFAULT` dataset on ereq. Every behaviour claimed in this paper has been
executed and verified against the live server; results are recorded in the rollout plan.

## 2. Tenant visibility options (the policy menu)

Every tenant is **private by default**: only principals explicitly granted that
partition can see it. Visibility is then opt-in per tenant, and all of the following
have been verified live on ereq:

| Model | How | Status |
|---|---|---|
| **Private** (default) | No extra grants. Anonymous and other tenants receive 403. | Verified |
| **Public read-only** | Add the tenant to the ANONYMOUS account's partition list. Anonymous holds no write permissions, so the tenant becomes world-readable, never writable. Reverting the grant restores privacy (allow up to ~1 minute for the auth cache). | Verified |
| **Shared with named principals (read-only)** | Grant an "observer" user or client `FHIR_ALL_READ` plus a partition list naming the tenants it may view, and no write permissions. Verified: reads both granted tenants (200), cannot read ungranted partitions including DEFAULT (403), cannot write anywhere (403). | Verified |
| **Shared read + own-tenant write in one session** | Not expressible with built-in permissions: partition access gates read and write together, and permissions are additive. A principal needing "read tenant X, write only tenant Y" in a single session requires a small consent-service script on the FHIR endpoint that rejects writes outside the principal's home tenant. | Design documented, not built |

Practical guidance that falls out of this:

- A vendor wanting their sandbox demo-able to everyone: one-line grant to ANONYMOUS.
- Two vendors pairing on a scenario (e.g. placer and filler from different companies):
  both are granted the same scenario tenant read-write. Verified pattern in the pilot.
- A vendor wanting to browse another vendor's data with permission: issue them a
  second, read-only observer credential listing the shared tenants. Two credentials
  is the price of avoiding custom code; the consent script removes that price if the
  need becomes common.
- Cross-tenant visibility is about API access only. Resources cannot reference
  across partitions, and subscriptions match only within their own partition,
  regardless of who can read what.

## 3. Security review inputs

- **Enforcement point**: Smile CDR partition security (`partitioning_security.enabled`,
  on by default). Partition access is enforced server-side per request; verified for
  users, clients, and anonymous, for reads and writes independently.
- **What the pilot verified empirically** (Phase 0 go/no-go matrix plus pilot checks):
  tenant privacy by default; no cross-tenant leakage via DEFAULT URLs; cross-partition
  ID collision rejected with 409 (no overwrite; historical HAPI defect does not
  reproduce on 2025.11.R02); conditional operations do not match across partitions;
  cross-partition references rejected; read-only observers cannot write.
- **Residual constraints to accept**: resource IDs are unique server-wide (tenants
  loading fixed-ID bundles collide; mitigate with server-assigned or prefixed IDs);
  no cross-tenant search in URL mode; permission changes can take ~1 minute to affect
  cached sessions; user accounts cannot be API-deleted (offboarding = disable + lock).
- **Anonymous surface**: unchanged for DEFAULT (read-only), and opt-in per tenant.
- **Not in scope of the model**: rate limiting, data volume quotas per tenant, and
  tenant-level audit reporting (the audit module is currently disabled). Raise at the
  workshop if these matter for opening write access more broadly.

## 4. Resourcing and maintenance

- **Provisioning**: tenant creation is one admin API call; scoped users/clients are
  created with the existing registration scripts (now tenant-aware). The SMART
  registration issue template already collects a tenant field, so tenant requests can
  ride the existing service-catalogue automation. Marginal effort per vendor:
  minutes, not hours.
- **Steady state**: the runbook adds four operations (create, grant, clear, delete
  tenant). No new infrastructure, modules, or licences. Monitoring, backup, and the
  deploy pipeline are unchanged.
- **Who does what**: proposal is that tenant lifecycle stays with repo admins via the
  service catalogue (same approval gates as SMART client registration today).
- **Data lifecycle**: policy needed on tenant retention (e.g. scenario tenants cleared
  after each event, vendor tenants persist until the vendor offboards). This is a
  workshop decision, not a technical constraint.

## 5. Timeline (what remains after the ereq pilot)

| Step | Effort | Dependency |
|---|---|---|
| Workshop decision on ADR 0001 and visibility policy | the meeting | this paper |
| aucore rollout (repeat of the ereq playbook, including the deferred `connectathon-backend-02` write removal) | ~half a day, no restarts | sign-off |
| Participant docs and comms (handout, Confluence, Zulip announcement) | ~half a day | aucore rollout |
| Tenant-request offering in the service catalogue (template + automation) | ~1 day | sign-off |
| Partition seed file in git (`fhir-partitions.json`), one pod roll, outside events | ~half a day | stable tenant list |
| Optional: consent-service script for mixed-session access | ~1 day incl. tests | demand |

## 6. Contract and agreement considerations

Nothing in the pilot changes the platform's legal posture, but three items are worth
confirming at the workshop:

1. **Terms of use / participant comms**: the dev server remains synthetic-data-only,
   best-effort SLA. Vendor sandboxes may create an expectation of persistence;
   the retention policy from section 4 should be stated wherever tenants are offered.
2. **Smile CDR licensing**: unchanged. Same instance, same nodes, same modules;
   partitioning is a feature of the existing licence tier (already enabled).
3. **HL7-hosted environments**: out of scope. The `hl7au` node and `fhir.hl7.org.au`
   are untouched, and any future extension follows the elevated approval process.

## 7. Deliverables (existing and proposed)

Delivered: ADR 0001, strategy paper, rollout plan with verified test matrix and
execution log, tenant-aware registration tooling, live ereq pilot, demo walkthrough.

Proposed for sign-off: aucore rollout per the playbook, visibility policy (section 2)
adopted as an ADR amendment, tenant-request catalogue offering, updated participant
handout, retention policy statement.

## 8. Decision points for the workshop

1. Endorse ADR 0001 (partition-per-tenant, read-only shared DEFAULT for participants,
   team accounts retain write)?
2. Adopt the visibility policy menu (private by default; public-read and observer
   grants on request; consent script only when single-session mixed access is proven
   necessary)?
3. Tenant retention policy: scenario tenants cleared per event, vendor tenants
   persist until offboarding?
4. Approve the aucore rollout and the participant comms plan?
5. Any requirement for per-tenant quotas, rate limits, or audit reporting before
   write access is offered broadly?
