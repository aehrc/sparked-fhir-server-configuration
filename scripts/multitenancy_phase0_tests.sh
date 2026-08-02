#!/usr/bin/env bash
# Phase 0 multitenancy rehearsal against a Sparked Dev FHIR Server node.
# Target node comes from PHASE0_NODE (default aucore); results path from PHASE0_RESULTS.
# Creates a temporary MTTEST partition, verifies isolation properties, then cleans up.
# Admin credentials are fetched from AWS Secrets Manager at runtime and kept in memory only.
set -u

NODE="${PHASE0_NODE:-aucore}"
BASE="https://smile.sparked-fhir.com/$NODE/fhir"
ADMINJSON="https://smile.sparked-fhir.com/$NODE/admin-json"
PART_ID=9001
PART_NAME="MTTEST"
TESTUSER="mt-phase0-vendor"
RESULTS="${PHASE0_RESULTS:-$(dirname "$0")/phase0-results.md}"

ADMIN_PASS=$(aws secretsmanager get-secret-value --secret-id smilecdr-user-passwords --query SecretString --output text | jq -r '."smilecdr-admin-password"')
if [ -z "$ADMIN_PASS" ] || [ "$ADMIN_PASS" = "null" ]; then echo "FATAL: could not fetch admin password"; exit 1; fi
TESTUSER_PASS=$(openssl rand -base64 18 | tr -d '/+=' )

echo "# Phase 0 results ($(date -u '+%Y-%m-%d %H:%M UTC'))" > "$RESULTS"
note() { echo "$1" | tee -a "$RESULTS"; }

# curl helpers: capture status + body, never echo credentials
acurl() { curl -s --max-time 30 -u "ADMIN:$ADMIN_PASS" -H "Content-Type: application/fhir+json" "$@"; }
ucurl() { curl -s --max-time 30 -u "$TESTUSER:$TESTUSER_PASS" -H "Content-Type: application/fhir+json" "$@"; }
anoncurl() { curl -s --max-time 30 -H "Content-Type: application/fhir+json" "$@"; }

note ""
note "## T1: list partitions (before)"
T1=$(acurl -o /tmp/t1.json -w "%{http_code}" "$BASE/DEFAULT/\$partition-management-list-partitions")
note "- HTTP $T1"
[ "$T1" = "200" ] && note "- names: $(jq -r '[.parameter[]?.part[]? | select(.name=="name") | .valueCode // .valueString] | join(", ")' /tmp/t1.json 2>/dev/null)"

note ""
note "## T2: create $PART_NAME partition (id $PART_ID)"
T2=$(acurl -o /tmp/t2.json -w "%{http_code}" -X POST "$BASE/DEFAULT/\$partition-management-create-partition" -d "{\"resourceType\":\"Parameters\",\"parameter\":[{\"name\":\"id\",\"valueInteger\":$PART_ID},{\"name\":\"name\",\"valueCode\":\"$PART_NAME\"},{\"name\":\"description\",\"valueString\":\"Phase 0 multitenancy rehearsal partition (temporary, safe to delete)\"}]}")
note "- HTTP $T2"
[ "$T2" != "200" ] && [ "$T2" != "201" ] && note "- body: $(head -c 500 /tmp/t2.json)"

note ""
note "## T3: anonymous access to new tenant is blocked"
T3=$(anoncurl -o /tmp/t3.json -w "%{http_code}" "$BASE/$PART_NAME/Patient?_count=1")
note "- anonymous GET /$PART_NAME/Patient: HTTP $T3 (expect 401/403)"

note ""
note "## T4: admin can write into $PART_NAME via tenant URL"
T4=$(acurl -o /tmp/t4.json -w "%{http_code}" -X PUT "$BASE/$PART_NAME/Patient/mt-phase0-scratch1" -d '{"resourceType":"Patient","id":"mt-phase0-scratch1","identifier":[{"system":"http://example.org/mt-phase0","value":"scratch-1"}],"name":[{"family":"ScratchTenant","given":["Original"]}]}')
note "- PUT /$PART_NAME/Patient/mt-phase0-scratch1: HTTP $T4 (expect 201)"
[ "$T4" != "200" ] && [ "$T4" != "201" ] && note "- body: $(head -c 700 /tmp/t4.json)"

note ""
note "## T5: anonymous read of DEFAULT unchanged"
T5=$(anoncurl -o /dev/null -w "%{http_code}" "$BASE/DEFAULT/Patient?_count=1")
note "- anonymous GET /DEFAULT/Patient: HTTP $T5 (expect 200)"
T5b=$(anoncurl -o /dev/null -w "%{http_code}" "$BASE/DEFAULT/Patient/mt-phase0-scratch1")
note "- anonymous GET /DEFAULT/Patient/mt-phase0-scratch1: HTTP $T5b (expect 404, resource lives only in $PART_NAME)"

note ""
note "## T6: client-assigned ID collision across partitions"
T6pre=$(acurl -o /dev/null -w "%{http_code}" "$BASE/DEFAULT/Patient/mt-phase0-collision")
note "- precheck DEFAULT/Patient/mt-phase0-collision: HTTP $T6pre (expect 404)"
T6a=$(acurl -o /tmp/t6a.json -w "%{http_code}" -X PUT "$BASE/$PART_NAME/Patient/mt-phase0-collision" -d '{"resourceType":"Patient","id":"mt-phase0-collision","name":[{"family":"InScratch"}]}')
note "- PUT /$PART_NAME/Patient/mt-phase0-collision: HTTP $T6a"
T6b=$(acurl -o /tmp/t6b.json -w "%{http_code}" -X PUT "$BASE/DEFAULT/Patient/mt-phase0-collision" -d '{"resourceType":"Patient","id":"mt-phase0-collision","name":[{"family":"InDefault"}]}')
note "- PUT /DEFAULT/Patient/mt-phase0-collision (same ID, different partition): HTTP $T6b"
[ "$T6b" != "200" ] && [ "$T6b" != "201" ] && note "- body: $(head -c 700 /tmp/t6b.json)"
T6c=$(acurl -o /tmp/t6c.json -w "%{http_code}" "$BASE/$PART_NAME/Patient/mt-phase0-collision")
T6d=$(acurl -o /tmp/t6d.json -w "%{http_code}" "$BASE/DEFAULT/Patient/mt-phase0-collision")
note "- after: $PART_NAME copy HTTP $T6c family=$(jq -r '.name[0].family // "n/a"' /tmp/t6c.json 2>/dev/null) v=$(jq -r '.meta.versionId // "n/a"' /tmp/t6c.json 2>/dev/null); DEFAULT copy HTTP $T6d family=$(jq -r '.name[0].family // "n/a"' /tmp/t6d.json 2>/dev/null) v=$(jq -r '.meta.versionId // "n/a"' /tmp/t6d.json 2>/dev/null)"

note ""
note "## T7: cross-partition local reference is rejected"
T7a=$(acurl -o /dev/null -w "%{http_code}" -X PUT "$BASE/DEFAULT/Patient/mt-phase0-reftarget" -d '{"resourceType":"Patient","id":"mt-phase0-reftarget","name":[{"family":"RefTarget"}]}')
note "- setup PUT /DEFAULT/Patient/mt-phase0-reftarget: HTTP $T7a"
T7b=$(acurl -o /tmp/t7b.json -w "%{http_code}" -X POST "$BASE/$PART_NAME/Observation" -d '{"resourceType":"Observation","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"8867-4"}]},"subject":{"reference":"Patient/mt-phase0-reftarget"}}')
note "- POST /$PART_NAME/Observation referencing DEFAULT patient: HTTP $T7b (expect 4xx rejection)"
note "- body: $(jq -r '.issue[0].diagnostics // empty' /tmp/t7b.json 2>/dev/null | head -c 400)"

note ""
note "## T8: conditional update does not match across partitions"
T8a=$(acurl -o /tmp/t8a.json -w "%{http_code}" -X PUT "$BASE/DEFAULT/Patient?identifier=http://example.org/mt-phase0|scratch-1" -d '{"resourceType":"Patient","identifier":[{"system":"http://example.org/mt-phase0","value":"scratch-1"}],"name":[{"family":"ConditionalInDefault"}]}')
note "- conditional PUT in DEFAULT with identifier that only exists in $PART_NAME: HTTP $T8a (expect 201 create, NOT cross-partition update)"
T8loc=$(acurl -s -o /dev/null -w "%{http_code}" "$BASE/$PART_NAME/Patient/mt-phase0-scratch1")
T8v=$(acurl -s "$BASE/$PART_NAME/Patient/mt-phase0-scratch1" | jq -r '.meta.versionId // "n/a"; .name[0].family // "n/a"' | paste -sd' ' -)
note "- $PART_NAME/Patient/mt-phase0-scratch1 after: HTTP $T8loc, versionId+family: $T8v (expect v1 ScratchTenant, untouched)"
T8id=$(jq -r '.id // empty' /tmp/t8a.json 2>/dev/null)
note "- created-in-DEFAULT id: ${T8id:-unknown}"

note ""
note "## T9: scoped vendor-style user (write $PART_NAME, no DEFAULT access)"
T9a=$(curl -s --max-time 30 -u "ADMIN:$ADMIN_PASS" -H "Content-Type: application/json" -o /tmp/t9a.json -w "%{http_code}" -X POST "$ADMINJSON/user-management/$NODE/local_security" -d "{\"username\":\"$TESTUSER\",\"password\":\"$TESTUSER_PASS\",\"givenName\":\"MTTest\",\"familyName\":\"Phase0\",\"authorities\":[{\"permission\":\"ROLE_FHIR_CLIENT\"},{\"permission\":\"FHIR_CAPABILITIES\"},{\"permission\":\"FHIR_ALL_READ\"},{\"permission\":\"FHIR_ALL_WRITE\"},{\"permission\":\"FHIR_TRANSACTION\"},{\"permission\":\"FHIR_ACCESS_PARTITION_NAME\",\"argument\":\"$PART_NAME\"}]}")
T9pid=$(jq -r '.pid // empty' /tmp/t9a.json 2>/dev/null)
note "- create user: HTTP $T9a (pid: ${T9pid:-unknown})"
if [ "$T9a" = "200" ] || [ "$T9a" = "201" ]; then
  T9b=$(ucurl -o /dev/null -w "%{http_code}" "$BASE/$PART_NAME/Patient?_count=1")
  note "- vendor GET /$PART_NAME/Patient: HTTP $T9b (expect 200)"
  T9c=$(ucurl -o /tmp/t9c.json -w "%{http_code}" -X POST "$BASE/$PART_NAME/Patient" -d '{"resourceType":"Patient","name":[{"family":"VendorWrite"}]}')
  T9cid=$(jq -r '.id // empty' /tmp/t9c.json 2>/dev/null)
  note "- vendor POST /$PART_NAME/Patient: HTTP $T9c (expect 201, id ${T9cid:-unknown})"
  T9d=$(ucurl -o /dev/null -w "%{http_code}" "$BASE/DEFAULT/Patient?_count=1")
  note "- vendor GET /DEFAULT/Patient: HTTP $T9d (expect 403, no DEFAULT partition access)"
  T9e=$(ucurl -o /dev/null -w "%{http_code}" -X POST "$BASE/DEFAULT/Patient" -d '{"resourceType":"Patient","name":[{"family":"ShouldFail"}]}')
  note "- vendor POST /DEFAULT/Patient: HTTP $T9e (expect 403)"
fi

note ""
note "## Cleanup"
for u in "$PART_NAME/Patient/mt-phase0-scratch1" "$PART_NAME/Patient/mt-phase0-collision" "DEFAULT/Patient/mt-phase0-collision" "DEFAULT/Patient/mt-phase0-reftarget"; do
  C=$(acurl -o /dev/null -w "%{http_code}" -X DELETE "$BASE/$u"); note "- DELETE $u: HTTP $C"
done
if [ -n "${T8id:-}" ]; then C=$(acurl -o /dev/null -w "%{http_code}" -X DELETE "$BASE/DEFAULT/Patient/$T8id"); note "- DELETE DEFAULT/Patient/$T8id (conditional-create artifact): HTTP $C"; fi
if [ -n "${T9cid:-}" ]; then C=$(acurl -o /dev/null -w "%{http_code}" -X DELETE "$BASE/$PART_NAME/Patient/$T9cid"); note "- DELETE $PART_NAME/Patient/$T9cid (vendor write artifact): HTTP $C"; fi
if [ -n "${T9pid:-}" ]; then
  C=$(curl -s --max-time 30 -u "ADMIN:$ADMIN_PASS" -o /tmp/t9del.json -w "%{http_code}" -X DELETE "$ADMINJSON/user-management/$NODE/local_security/$T9pid")
  note "- DELETE test user pid $T9pid: HTTP $C"
  if [ "$C" != "200" ] && [ "$C" != "204" ]; then
    C2=$(curl -s --max-time 30 -u "ADMIN:$ADMIN_PASS" -H "Content-Type: application/json" -o /dev/null -w "%{http_code}" -X PUT "$ADMINJSON/user-management/$NODE/local_security/$T9pid" -d "{\"username\":\"$TESTUSER\",\"accountDisabled\":true,\"accountLocked\":true,\"authorities\":[]}")
    note "- user delete unsupported; disabled+locked instead: HTTP $C2"
  fi
fi
CDEL=$(acurl -o /tmp/cdel.json -w "%{http_code}" -X POST "$BASE/DEFAULT/\$partition-management-delete-partition" -d "{\"resourceType\":\"Parameters\",\"parameter\":[{\"name\":\"id\",\"valueInteger\":$PART_ID}]}")
note "- delete $PART_NAME partition: HTTP $CDEL"
[ "$CDEL" != "200" ] && note "- body: $(head -c 500 /tmp/cdel.json)"

note ""
note "## Post-cleanup verification"
P1=$(anoncurl -o /dev/null -w "%{http_code}" "$BASE/$PART_NAME/Patient?_count=1")
note "- anonymous GET /$PART_NAME/Patient after partition delete: HTTP $P1 (expect 4xx, tenant gone)"
P2=$(anoncurl -o /dev/null -w "%{http_code}" "$BASE/DEFAULT/Patient?_count=1")
note "- anonymous GET /DEFAULT/Patient: HTTP $P2 (expect 200)"
echo ""
echo "Done. Results in $RESULTS"
