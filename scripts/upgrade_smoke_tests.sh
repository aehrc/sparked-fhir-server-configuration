#!/usr/bin/env bash
# Smoke tests for Smile CDR upgrades (see docs/smilecdr-2026.05-upgrade-plan.md).
#
# Read-only by default. Run once before an upgrade to capture a baseline, then
# after each upgrade phase and compare the results files.
#
# Usage:
#   ./upgrade_smoke_tests.sh [-o results.md] [--expect-version 2026.05.R01] [--write]
#
#   -o FILE             write markdown results to FILE (default: upgrade-smoke-results.md)
#   --expect-version V  fail if any node does not report Smile CDR version V
#   --write             also do a create/read/delete round-trip with a tagged test
#                       Patient on ereq DEFAULT (off by default)
#
# Requires: curl, jq, aws CLI with access to the smilecdr-user-passwords secret.
set -u

BASE="https://smile.sparked-fhir.com"
NODES=(aucore hl7au ereq)
EREQ_TENANTS=(DEFAULT SCENARIO-EREQ-MEDS VENDOR-DEMO)
RESULTS="upgrade-smoke-results.md"
EXPECT_VERSION=""
DO_WRITE=0

while [ $# -gt 0 ]; do
  case "$1" in
    -o) RESULTS="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --write) DO_WRITE=1; shift ;;
    *) echo "Unknown argument: $1"; exit 2 ;;
  esac
done

ADMIN_PASS=$(aws secretsmanager get-secret-value --secret-id smilecdr-user-passwords \
  --query SecretString --output text | jq -r '."smilecdr-admin-password"')
if [ -z "$ADMIN_PASS" ] || [ "$ADMIN_PASS" = "null" ]; then
  echo "FATAL: could not fetch admin password from Secrets Manager"; exit 1
fi

PASS=0; FAIL=0; SKIP=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "# Upgrade smoke test results ($(date -u '+%Y-%m-%d %H:%M UTC'))" > "$RESULTS"
[ -n "$EXPECT_VERSION" ] && echo "Expected Smile CDR version: $EXPECT_VERSION" >> "$RESULTS"

note()  { echo "$1" | tee -a "$RESULTS"; }
ok()    { PASS=$((PASS+1)); note "- PASS: $1"; }
bad()   { FAIL=$((FAIL+1)); note "- FAIL: $1"; }
skip()  { SKIP=$((SKIP+1)); note "- SKIP: $1"; }

# curl helpers: capture status code, body goes to a temp file, never echo credentials
acurl() { curl -s --max-time 60 -u "ADMIN:$ADMIN_PASS" -H "Content-Type: application/fhir+json" "$@"; }
anoncurl() { curl -s --max-time 60 -H "Content-Type: application/fhir+json" "$@"; }

# ---------------------------------------------------------------------------
# Per-node checks
# ---------------------------------------------------------------------------
for node in "${NODES[@]}"; do
  note ""
  note "## Node: $node"
  fhir="$BASE/$node/fhir/DEFAULT"

  # 1. metadata + version
  code=$(anoncurl -o "$TMP/meta.json" -w "%{http_code}" "$fhir/metadata")
  if [ "$code" = "200" ]; then
    ver=$(jq -r '.software.version // empty' "$TMP/meta.json")
    ok "metadata HTTP 200 (software.version: ${ver:-unknown})"
    if [ -n "$EXPECT_VERSION" ]; then
      case "$ver" in
        *"$EXPECT_VERSION"*) ok "version matches expected $EXPECT_VERSION" ;;
        *) bad "version is '$ver', expected $EXPECT_VERSION" ;;
      esac
    fi
  else
    bad "metadata HTTP $code"
  fi

  # 2. SMART / OIDC discovery
  code=$(anoncurl -o "$TMP/smart.json" -w "%{http_code}" "$fhir/.well-known/smart-configuration")
  [ "$code" = "200" ] && ok "smart-configuration HTTP 200" || bad "smart-configuration HTTP $code"
  code=$(anoncurl -o "$TMP/oidc.json" -w "%{http_code}" "$BASE/$node/smartauth/.well-known/openid-configuration")
  [ "$code" = "200" ] && ok "openid-configuration HTTP 200" || bad "openid-configuration HTTP $code"

  # 3. resource counts (compare across runs by eye)
  for rt in Patient StructureDefinition; do
    code=$(acurl -o "$TMP/count.json" -w "%{http_code}" "$fhir/$rt?_summary=count")
    if [ "$code" = "200" ]; then
      total=$(jq -r '.total // "?"' "$TMP/count.json")
      ok "$rt count on DEFAULT: $total"
    else
      bad "$rt count on DEFAULT: HTTP $code"
    fi
  done

  # 4. request validation still active: an invalid resource must not validate cleanly
  code=$(acurl -o "$TMP/val.json" -w "%{http_code}" -X POST "$fhir/Patient/\$validate" \
    -d '{"resourceType":"Patient","gender":"not-a-valid-gender"}')
  issues=$(jq -r '[.issue[]? | select(.severity=="error" or .severity=="fatal")] | length' "$TMP/val.json" 2>/dev/null)
  if [ "$code" = "422" ] || { [ "$code" = "200" ] && [ "${issues:-0}" -gt 0 ]; } || [ "$code" = "400" ]; then
    ok "\$validate rejects invalid resource (HTTP $code, ${issues:-?} error issues)"
  else
    bad "\$validate unexpected result (HTTP $code, ${issues:-?} error issues)"
  fi
done

# ---------------------------------------------------------------------------
# ereq tenant checks (multitenancy)
# ---------------------------------------------------------------------------
note ""
note "## ereq tenants"
for tenant in "${EREQ_TENANTS[@]}"; do
  fhir="$BASE/ereq/fhir/$tenant"
  code=$(anoncurl -o "$TMP/meta.json" -w "%{http_code}" "$fhir/metadata")
  [ "$code" = "200" ] && ok "$tenant metadata HTTP 200" || bad "$tenant metadata HTTP $code"
  code=$(acurl -o "$TMP/count.json" -w "%{http_code}" "$fhir/Patient?_summary=count")
  if [ "$code" = "200" ]; then
    ok "$tenant Patient count: $(jq -r '.total // "?"' "$TMP/count.json")"
  else
    bad "$tenant Patient count: HTTP $code"
  fi
done

# ---------------------------------------------------------------------------
# IG seeding: AU Core patient profile resolvable on aucore
# ---------------------------------------------------------------------------
note ""
note "## IG package seeding"
code=$(acurl -o "$TMP/sd.json" -w "%{http_code}" \
  "$BASE/aucore/fhir/DEFAULT/StructureDefinition?url=http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient&_summary=count")
if [ "$code" = "200" ] && [ "$(jq -r '.total // 0' "$TMP/sd.json")" -ge 1 ]; then
  ok "au-core-patient StructureDefinition present on aucore"
else
  bad "au-core-patient StructureDefinition lookup (HTTP $code, total $(jq -r '.total // "?"' "$TMP/sd.json" 2>/dev/null))"
fi

# ---------------------------------------------------------------------------
# Ingress body-size limit: ~3 MiB request must pass nginx (anything but 413)
# ---------------------------------------------------------------------------
note ""
note "## Ingress body-size limit"
python3 -c "
import json
pad = 'x' * (3 * 1024 * 1024)
print(json.dumps({'resourceType':'Patient','text':{'status':'generated','div':'<div xmlns=\"http://www.w3.org/1999/xhtml\">'+pad+'</div>'}}))
" > "$TMP/big.json" 2>/dev/null
if [ -s "$TMP/big.json" ]; then
  code=$(acurl -o "$TMP/bigresp.json" -w "%{http_code}" -X POST \
    "$BASE/aucore/fhir/DEFAULT/Patient/\$validate" --data-binary "@$TMP/big.json")
  if [ "$code" = "413" ]; then
    bad "3 MiB request rejected with HTTP 413 (proxy-body-size regression)"
  else
    ok "3 MiB request passed the ingress (HTTP $code)"
  fi
else
  skip "could not build large payload (python3 unavailable?)"
fi

# ---------------------------------------------------------------------------
# AUPS generation ($summary via the custom generator jar)
# ---------------------------------------------------------------------------
note ""
note "## AU Patient Summary (\$summary, custom AUPS generator)"
for target in "aucore DEFAULT" "ereq SCENARIO-EREQ-MEDS"; do
  set -- $target; node=$1; tenant=$2
  fhir="$BASE/$node/fhir/$tenant"
  code=$(acurl -o "$TMP/p.json" -w "%{http_code}" "$fhir/Patient?_count=1")
  pid=$(jq -r '.entry[0].resource.id // empty' "$TMP/p.json" 2>/dev/null)
  if [ "$code" != "200" ] || [ -z "$pid" ]; then
    skip "$node/$tenant: no patient available to test \$summary (HTTP $code)"
    continue
  fi
  code=$(acurl -o "$TMP/sum.json" -w "%{http_code}" "$fhir/Patient/$pid/\$summary")
  btype=$(jq -r '.type // empty' "$TMP/sum.json" 2>/dev/null)
  if [ "$code" = "200" ] && [ "$btype" = "document" ]; then
    ok "$node/$tenant: \$summary returned a document Bundle for Patient/$pid"
  else
    bad "$node/$tenant: \$summary failed (HTTP $code, bundle type '${btype:-none}') for Patient/$pid"
  fi
done

# ---------------------------------------------------------------------------
# Optional write path: create/read/delete a tagged test Patient (ereq DEFAULT)
# ---------------------------------------------------------------------------
if [ "$DO_WRITE" = "1" ]; then
  note ""
  note "## Write round-trip (ereq DEFAULT)"
  fhir="$BASE/ereq/fhir/DEFAULT"
  code=$(acurl -o "$TMP/create.json" -w "%{http_code}" -X POST "$fhir/Patient" -d '{
    "resourceType":"Patient",
    "identifier":[{"system":"urn:sparked:upgrade-smoke","value":"upgrade-smoke-test"}],
    "name":[{"family":"UpgradeSmokeTest"}],
    "gender":"other"
  }')
  pid=$(jq -r '.id // empty' "$TMP/create.json" 2>/dev/null)
  if [ "$code" = "201" ] && [ -n "$pid" ]; then
    ok "create Patient/$pid (HTTP 201)"
    code=$(acurl -o /dev/null -w "%{http_code}" "$fhir/Patient/$pid")
    [ "$code" = "200" ] && ok "read back Patient/$pid" || bad "read back Patient/$pid: HTTP $code"
    code=$(acurl -o /dev/null -w "%{http_code}" -X DELETE "$fhir/Patient/$pid")
    { [ "$code" = "200" ] || [ "$code" = "204" ]; } && ok "delete Patient/$pid" || bad "delete Patient/$pid: HTTP $code"
  else
    bad "create test Patient: HTTP $code"
  fi
fi

# ---------------------------------------------------------------------------
note ""
note "## Summary: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
