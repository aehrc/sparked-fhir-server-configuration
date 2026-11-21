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
#                       Patient on aucore DEFAULT (off by default)
#   --connect-to HOST   send every request to load balancer HOST (e.g. the Envoy
#                       Gateway NLB) while keeping SNI and the Host header as
#                       smile.sparked-fhir.com. Lets a new load balancer be verified
#                       on its own DNS name before the smile.sparked-fhir.com record is
#                       flipped to it (Gateway API migration, side-by-side testing).
#
# Exit status is 0 only when every check passed. Every FAIL line says what the
# check expected and what came back (HTTP status plus the server's
# OperationOutcome diagnostics, or the start of the body when it is not FHIR).
#
# Data checks search with _count=1 and expect at least one entry. The server
# refuses search totals by design (HAPI-2038 for _summary=count, HAPI-2037 for
# _total=accurate), so the results show which resource each search found rather
# than a count.
#
# Requires: curl, jq, python3, aws CLI with access to the smilecdr-user-passwords secret.
set -u

BASE="https://smile.sparked-fhir.com"
# aucore is the only node since the ereq and hl7au decommission (2026-08-02).
NODES=(aucore)
# Tenants to exercise. Partitions are runtime objects, not config, so keep this in
# step with the live tenant list (admin console, Partition Management). This was
# the ereq tenant set until the decommission.
AUCORE_TENANTS=(DEFAULT)
# node/tenant pairs for the $summary (AU Patient Summary generator) check.
SUMMARY_TARGETS=(aucore/DEFAULT)
AU_CORE_PATIENT_SD="http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient"
RESULTS="upgrade-smoke-results.md"
EXPECT_VERSION=""
DO_WRITE=0
CONNECT_TO=()

while [ $# -gt 0 ]; do
  case "$1" in
    -o) RESULTS="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --write) DO_WRITE=1; shift ;;
    --connect-to)
      # Reroute smile.sparked-fhir.com:{443,80} to the target LB host, preserving SNI/Host.
      CONNECT_TO=(--connect-to "smile.sparked-fhir.com:443:$2:443" \
                  --connect-to "smile.sparked-fhir.com:80:$2:80")
      shift 2 ;;
    *) echo "Unknown argument: $1"; exit 2 ;;
  esac
done

ADMIN_PASS=$(aws secretsmanager get-secret-value --secret-id smilecdr-user-passwords \
  --query SecretString --output text | jq -r '."smilecdr-admin-password"')
if [ -z "$ADMIN_PASS" ] || [ "$ADMIN_PASS" = "null" ]; then
  echo "FATAL: expected the smilecdr-admin-password key in Secrets Manager secret smilecdr-user-passwords, got nothing (is the AWS session current?)"
  exit 1
fi

PASS=0; FAIL=0; SKIP=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "# Upgrade smoke test results ($(date -u '+%Y-%m-%d %H:%M UTC'))" > "$RESULTS"
[ -n "$EXPECT_VERSION" ] && echo "Expected Smile CDR version: $EXPECT_VERSION" >> "$RESULTS"

note()  { echo "$1" | tee -a "$RESULTS"; }
ok()    { PASS=$((PASS+1)); note "- PASS: $1"; }
bad()   { FAIL=$((FAIL+1)); note "- FAIL: $1"; }
skip()  { SKIP=$((SKIP+1)); note "- SKIP: $1"; }

# curl helpers: capture status code, body goes to a temp file, never echo credentials.
# ${CONNECT_TO[@]+...} guards the empty-array case under `set -u` (bash 3.2 safe).
acurl() { curl -s --max-time 60 ${CONNECT_TO[@]+"${CONNECT_TO[@]}"} -u "ADMIN:$ADMIN_PASS" -H "Content-Type: application/fhir+json" "$@"; }
anoncurl() { curl -s --max-time 60 ${CONNECT_TO[@]+"${CONNECT_TO[@]}"} -H "Content-Type: application/fhir+json" "$@"; }

# req admin|anon OUTFILE CURL_ARGS...: print the HTTP status ("000" when no response
# arrived). The body file is removed first so a failed request can never be judged
# on the body of an earlier one.
req() {
  local auth=$1 out=$2
  shift 2
  rm -f "$out"
  if [ "$auth" = "admin" ]; then
    acurl -o "$out" -w "%{http_code}" "$@"
  else
    anoncurl -o "$out" -w "%{http_code}" "$@"
  fi
}

# got CODE BODYFILE: describe what came back, for a FAIL line.
got() {
  local code=$1 body=$2 diag
  if [ "$code" = "000" ]; then
    echo "no HTTP response (connection failed or timed out after 60 s)"
    return
  fi
  if [ ! -s "$body" ]; then
    echo "HTTP $code with an empty body"
    return
  fi
  if ! jq -e . "$body" >/dev/null 2>&1; then
    echo "HTTP $code with a non-JSON body: $(head -c 160 "$body" | tr -s '\r\n\t' '   ')"
    return
  fi
  diag=$(jq -r 'select(.resourceType == "OperationOutcome")
    | [.issue[]? | .diagnostics // .details.text // empty] | first // empty' "$body")
  if [ -n "$diag" ]; then
    echo "HTTP $code: $diag"
  else
    echo "HTTP $code with a $(jq -r '.resourceType // "non-FHIR JSON"' "$body" 2>/dev/null) body"
  fi
}

# expect_200 LABEL URL: pass on HTTP 200 (anonymous; these endpoints are public).
expect_200() {
  local label=$1 url=$2 code
  code=$(req anon "$TMP/get.json" "$url")
  if [ "$code" = "200" ]; then
    ok "$label HTTP 200"
  else
    bad "$label: expected HTTP 200, got $(got "$code" "$TMP/get.json")"
  fi
}

# expect_data LABEL SEARCH_URL: the search must return HTTP 200 and a Bundle with at
# least one entry, i.e. data of that type is loaded. Reports the first match.
expect_data() {
  local label=$1 url=$2 code n first
  code=$(req admin "$TMP/search.json" "$url")
  if [ "$code" != "200" ]; then
    bad "$label: expected HTTP 200 and a Bundle with at least 1 entry, got $(got "$code" "$TMP/search.json")"
    return
  fi
  n=$(jq -r 'if .resourceType == "Bundle" then (.entry // [] | length) else empty end' \
    "$TMP/search.json" 2>/dev/null)
  if [ -z "$n" ]; then
    bad "$label: expected HTTP 200 and a Bundle with at least 1 entry, got $(got "$code" "$TMP/search.json")"
  elif [ "$n" -eq 0 ]; then
    bad "$label: expected a Bundle with at least 1 entry, got HTTP 200 with 0 entries (no data loaded?)"
  else
    first=$(jq -r '.entry[0].resource | "\(.resourceType)/\(.id)"' "$TMP/search.json")
    ok "$label: data present (search found $first)"
  fi
}

# ---------------------------------------------------------------------------
# Per-node checks
# ---------------------------------------------------------------------------
for node in "${NODES[@]}"; do
  note ""
  note "## Node: $node"
  fhir="$BASE/$node/fhir/DEFAULT"

  # 1. metadata + version
  code=$(req anon "$TMP/meta.json" "$fhir/metadata")
  if [ "$code" = "200" ]; then
    ver=$(jq -r '.software.version // empty' "$TMP/meta.json" 2>/dev/null)
    ok "metadata HTTP 200 (software.version: ${ver:-unknown})"
    if [ -n "$EXPECT_VERSION" ]; then
      case "$ver" in
        *"$EXPECT_VERSION"*) ok "version matches expected $EXPECT_VERSION" ;;
        *) bad "version: expected $EXPECT_VERSION, got '${ver:-none}' in software.version" ;;
      esac
    fi
  else
    bad "metadata: expected HTTP 200, got $(got "$code" "$TMP/meta.json")"
  fi

  # 2. SMART / OIDC discovery
  expect_200 "smart-configuration" "$fhir/.well-known/smart-configuration"
  expect_200 "openid-configuration" "$BASE/$node/smartauth/.well-known/openid-configuration"

  # 3. data loaded (bounded search; the server refuses search totals)
  for rt in Patient StructureDefinition; do
    expect_data "$rt on DEFAULT" "$fhir/$rt?_count=1&_elements=id"
  done

  # 4. request validation still active: an invalid resource must not validate cleanly
  code=$(req admin "$TMP/val.json" -X POST "$fhir/Patient/\$validate" \
    -d '{"resourceType":"Patient","gender":"not-a-valid-gender"}')
  issues=$(jq -r '[.issue[]? | select(.severity=="error" or .severity=="fatal")] | length' "$TMP/val.json" 2>/dev/null)
  if [ "$code" = "422" ] || [ "$code" = "400" ] || { [ "$code" = "200" ] && [ "${issues:-0}" -gt 0 ]; }; then
    ok "\$validate rejects invalid resource (HTTP $code, ${issues:-?} error issues)"
  else
    bad "\$validate of an invalid Patient: expected HTTP 400 or 422, or HTTP 200 with at least 1 error issue, got $(got "$code" "$TMP/val.json") (${issues:-?} error issues)"
  fi
done

# ---------------------------------------------------------------------------
# aucore tenant checks (multitenancy)
# ---------------------------------------------------------------------------
note ""
note "## aucore tenants"
for tenant in "${AUCORE_TENANTS[@]}"; do
  fhir="$BASE/aucore/fhir/$tenant"
  expect_200 "$tenant metadata" "$fhir/metadata"
  expect_data "$tenant Patient" "$fhir/Patient?_count=1&_elements=id"
done

# ---------------------------------------------------------------------------
# IG seeding: AU Core patient profile resolvable on aucore
# ---------------------------------------------------------------------------
note ""
note "## IG package seeding"
code=$(req admin "$TMP/sd.json" \
  "$BASE/aucore/fhir/DEFAULT/StructureDefinition?url=$AU_CORE_PATIENT_SD&_elements=url,version")
n=$(jq -r 'if .resourceType == "Bundle" then (.entry // [] | length) else empty end' "$TMP/sd.json" 2>/dev/null)
if [ "$code" = "200" ] && [ "${n:-0}" -ge 1 ]; then
  versions=$(jq -r '[.entry[].resource.version // "no version"] | join(", ")' "$TMP/sd.json")
  ok "au-core-patient StructureDefinition present on aucore (versions: $versions)"
elif [ "$code" = "200" ] && [ -n "$n" ]; then
  bad "au-core-patient StructureDefinition: expected at least 1 match for url $AU_CORE_PATIENT_SD, got HTTP 200 with 0 entries (AU Core package not installed?)"
else
  bad "au-core-patient StructureDefinition: expected HTTP 200 and a Bundle with at least 1 entry, got $(got "$code" "$TMP/sd.json")"
fi

# ---------------------------------------------------------------------------
# Ingress body-size limit: ~3 MiB request must pass the proxy (anything but 413)
# ---------------------------------------------------------------------------
note ""
note "## Ingress body-size limit"
python3 -c "
import json
pad = 'x' * (3 * 1024 * 1024)
print(json.dumps({'resourceType':'Patient','text':{'status':'generated','div':'<div xmlns=\"http://www.w3.org/1999/xhtml\">'+pad+'</div>'}}))
" > "$TMP/big.json" 2>/dev/null
if [ -s "$TMP/big.json" ]; then
  code=$(req admin "$TMP/bigresp.json" -X POST \
    "$BASE/aucore/fhir/DEFAULT/Patient/\$validate" --data-binary "@$TMP/big.json")
  if [ "$code" = "413" ]; then
    bad "3 MiB request: expected any HTTP status but 413, got HTTP 413 (proxy body-size regression)"
  elif [ "$code" = "000" ]; then
    bad "3 MiB request: expected any HTTP status but 413, got $(got "$code" "$TMP/bigresp.json")"
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
for target in "${SUMMARY_TARGETS[@]}"; do
  node=${target%%/*}; tenant=${target#*/}
  fhir="$BASE/$node/fhir/$tenant"
  code=$(req admin "$TMP/p.json" "$fhir/Patient?_count=1&_elements=id")
  pid=$(jq -r '.entry[0].resource.id // empty' "$TMP/p.json" 2>/dev/null)
  if [ "$code" != "200" ] || [ -z "$pid" ]; then
    skip "$node/$tenant: no patient available to test \$summary ($(got "$code" "$TMP/p.json"))"
    continue
  fi
  code=$(req admin "$TMP/sum.json" "$fhir/Patient/$pid/\$summary")
  btype=$(jq -r '.type // empty' "$TMP/sum.json" 2>/dev/null)
  if [ "$code" = "200" ] && [ "$btype" = "document" ]; then
    ok "$node/$tenant: \$summary returned a document Bundle for Patient/$pid"
  elif [ "$code" = "200" ]; then
    bad "$node/$tenant: \$summary for Patient/$pid: expected a Bundle of type document, got HTTP 200 with type '${btype:-none}'"
  else
    bad "$node/$tenant: \$summary for Patient/$pid: expected HTTP 200 and a document Bundle, got $(got "$code" "$TMP/sum.json")"
  fi
done

# ---------------------------------------------------------------------------
# Optional write path: create/read/delete a tagged test Patient (aucore DEFAULT)
#
# Moved from ereq DEFAULT at the ereq decommission. This writes into the curated
# shared dataset, so it stays off by default and the resource is deleted again
# immediately. It uses the admin credential, which multitenancy Phase 2 kept
# read/write on DEFAULT (only participant principals lost write).
# ---------------------------------------------------------------------------
if [ "$DO_WRITE" = "1" ]; then
  note ""
  note "## Write round-trip (aucore DEFAULT)"
  fhir="$BASE/aucore/fhir/DEFAULT"
  code=$(req admin "$TMP/create.json" -X POST "$fhir/Patient" -d '{
    "resourceType":"Patient",
    "identifier":[{"system":"urn:sparked:upgrade-smoke","value":"upgrade-smoke-test"}],
    "name":[{"family":"UpgradeSmokeTest"}],
    "gender":"other"
  }')
  pid=$(jq -r '.id // empty' "$TMP/create.json" 2>/dev/null)
  if [ "$code" = "201" ] && [ -n "$pid" ]; then
    ok "create Patient/$pid (HTTP 201)"
    code=$(req admin "$TMP/readback.json" "$fhir/Patient/$pid")
    if [ "$code" = "200" ]; then
      ok "read back Patient/$pid"
    else
      bad "read back Patient/$pid: expected HTTP 200, got $(got "$code" "$TMP/readback.json")"
    fi
    code=$(req admin "$TMP/delete.json" -X DELETE "$fhir/Patient/$pid")
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
      ok "delete Patient/$pid"
    else
      bad "delete Patient/$pid: expected HTTP 200 or 204, got $(got "$code" "$TMP/delete.json")"
    fi
  elif [ "$code" = "201" ]; then
    bad "create test Patient: expected HTTP 201 with the new id in the body, got HTTP 201 without an id"
  else
    bad "create test Patient: expected HTTP 201, got $(got "$code" "$TMP/create.json")"
  fi
fi

# ---------------------------------------------------------------------------
note ""
note "## Summary: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
