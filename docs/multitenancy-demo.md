# Multitenancy demo: ereq pilot walkthrough

A guided demo of partition-based multitenancy on the `ereq` node, as rolled out per
[ADR 0001](adr/0001-partition-based-multitenancy.md) and the [rollout plan](multitenancy-rollout-plan.md).
Every command below was executed and verified on 2026-07-13/14 against the live server.

## What exists after the pilot rollout

| Thing | Value |
|---|---|
| Scenario tenant | `SCENARIO-EREQ-MEDS` (partition id 100) at `https://smile.sparked-fhir.com/ereq/fhir/SCENARIO-EREQ-MEDS` |
| Vendor tenant | `VENDOR-DEMO` (partition id 101) at `https://smile.sparked-fhir.com/ereq/fhir/VENDOR-DEMO` |
| Demo users | `demo-placer`, `demo-filler` (scoped to SCENARIO-EREQ-MEDS), `demo-vendor` (scoped to VENDOR-DEMO); all read-write inside their tenant, no DEFAULT access |
| Observer user | `demo-observer`: read-only across both pilot tenants (`FHIR_ALL_READ`, no write permissions, partition list `SCENARIO-EREQ-MEDS,VENDOR-DEMO`). Demonstrates opt-in cross-tenant read sharing; per-tenant public (anonymous) read is also verified, see the workshop pre-paper |
| Scenario data | Self-contained medications flow: Patient, Practitioner, Organization, MedicationRequest (AMT 23551011000036108, Amoxicillin 500 mg capsule), and a fulfil Task that demo-filler has driven requested to in-progress to completed |
| DEFAULT tenant | Read-only for participants; team accounts (ADMIN, DevTester, placer, filler) unchanged |

Demo user passwords are held by the Sparked team (not in this repo). Set them as
environment variables before running the walkthrough:

```bash
export DEMO_PLACER_PASS='...'
export DEMO_FILLER_PASS='...'
export DEMO_VENDOR_PASS='...'
BASE=https://smile.sparked-fhir.com/ereq/fhir
```

## The pitch, in six commands

**1. The shared data is still there, public, unchanged:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/DEFAULT/Patient?_count=1"        # 200
```

**2. But tenants are private. Anonymous (and other tenants) get 403:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/SCENARIO-EREQ-MEDS/Patient?_count=1"   # 403
```

**3. A scenario participant has full read/write inside the scenario tenant.**
The medications flow is already loaded; show the completed dispense Task:

```bash
curl -s -u "demo-placer:$DEMO_PLACER_PASS" \
  "$BASE/SCENARIO-EREQ-MEDS/Task/task-demo-dispense" | jq '{status, owner, focus}'
# status: completed, owner: Demo Filler (pharmacy), focus: MedicationRequest/mr-demo-amoxicillin
```

Live-write moment: have demo-placer create a second MedicationRequest on the spot:

```bash
curl -s -u "demo-placer:$DEMO_PLACER_PASS" -H "Content-Type: application/fhir+json" \
  -o /dev/null -w "%{http_code}\n" -X POST "$BASE/SCENARIO-EREQ-MEDS/MedicationRequest" \
  -d '{"resourceType":"MedicationRequest","status":"active","intent":"order",
       "medicationCodeableConcept":{"coding":[{"system":"http://snomed.info/sct",
       "code":"23551011000036108","display":"Amoxicillin 500 mg capsule"}]},
       "subject":{"reference":"Patient/pat-demo-wang"}}'    # 201
```

**4. The same participant cannot touch the shared data, read or write:**

```bash
curl -s -u "demo-placer:$DEMO_PLACER_PASS" -o /dev/null -w "%{http_code}\n" \
  "$BASE/DEFAULT/Patient?_count=1"                                               # 403
curl -s -u "demo-placer:$DEMO_PLACER_PASS" -H "Content-Type: application/fhir+json" \
  -o /dev/null -w "%{http_code}\n" -X POST "$BASE/DEFAULT/Patient" \
  -d '{"resourceType":"Patient"}'                                                # 403
```

**5. Tenants cannot see each other.** The vendor sandbox user is blind to the scenario tenant:

```bash
curl -s -u "demo-vendor:$DEMO_VENDOR_PASS" -o /dev/null -w "%{http_code}\n" \
  "$BASE/SCENARIO-EREQ-MEDS/Patient?_count=1"                                    # 403
curl -s -u "demo-vendor:$DEMO_VENDOR_PASS" -o /dev/null -w "%{http_code}\n" \
  "$BASE/VENDOR-DEMO/Patient?_count=1"                                           # 200
```

**6. Provisioning a new tenant is one API call, no restart, no deployment**
(admin credentials; the pods have not restarted throughout this entire rollout):

```bash
curl -s -u "ADMIN:$ADMIN_PASS" -H "Content-Type: application/fhir+json" \
  -X POST "$BASE/DEFAULT/\$partition-management-create-partition" \
  -d '{"resourceType":"Parameters","parameter":[
        {"name":"id","valueInteger":102},
        {"name":"name","valueCode":"VENDOR-NEWCO"},
        {"name":"description","valueString":"NewCo sandbox"}]}'
```

## Talking points

- Everything above is **pure configuration**: no custom interceptors, no new modules,
  no schema changes. Partitioning was already enabled (the `/DEFAULT` in every URL);
  the pilot added tenants and scoped permissions.
- The medications flow answers the most common connectathon request: **real write
  access for eRequesting placer/filler workflows**, without risking the curated data.
- Custom test data now has a home: a vendor loads a self-contained bundle into their
  tenant and it survives shared-data clears between events.
- Conformance content (AU Core / eRequesting profiles, terminology) is served to every
  tenant from the shared store automatically, so validation behaves identically in
  every tenant.
- Rollout was staged exactly as the plan prescribes: rehearsal with a disposable
  tenant and a go/no-go matrix (all passed), then pilot tenants, then participant
  write removal on DEFAULT. aucore follows after sign-off.

## Registering real vendors (post-demo)

```bash
# A vendor user scoped to their own tenant
python scripts/manage_smart_users.py --node ereq --username acme-dev-01 \
  --permissions read-write --tenant VENDOR-ACME

# A backend service client scoped to their tenant
python scripts/register_smart_client.py --node ereq --client-type backend-service \
  --client-id acme-loader --scopes "system/*.*" --tenant VENDOR-ACME
```

The SMART registration issue template now has a Tenant field, so requests arrive
with this information.

## Rollback

- Demo tenants: delete resources then `$partition-management-delete-partition`
  (ids 100, 101). Demo users: disable and lock via the admin console or API.
- Participant write removal: before-state snapshots of every changed principal are
  retained by the team; each is a single PUT to restore.
- The DEFAULT tenant data, team accounts, and the hl7au node were not modified.
  (aucore was subsequently rolled out on 2026-07-15; see the rollout plan execution log.)
