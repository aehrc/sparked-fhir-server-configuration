#!/usr/bin/env bash
# Fetch or push the two gitignored files that a local Smile CDR apply needs:
#
#   tfvars/sparkey.tfvars           <->  Secrets Manager sparked/smile/terraform/sparkey-tfvars
#   terraform/backend-sparkey.hcl   <->  Secrets Manager sparked/smile/terraform/backend-sparkey-hcl
#
# Both hold identifiers (state bucket and key, secret and role names), not
# credentials. They stay out of git because this repository is public; they live
# in Secrets Manager so that the apply does not depend on one workstation. See
# docs/smile-deploy-inputs.md for the design, who can read them and how they were
# first stored.
#
# Usage:
#   scripts/fetch-smile-tfvars.sh [fetch] [--force]   write both files locally (0600)
#   scripts/fetch-smile-tfvars.sh status              compare local files with the stored copies
#   scripts/fetch-smile-tfvars.sh push [--yes]        store the local files as new secret versions
#
# fetch refuses to overwrite a local file that differs from the stored copy unless
# --force is given: a local edit that was never pushed is exactly what this script
# exists to stop losing. push asks before writing unless --yes is given.
#
# Requires: aws CLI v2 with credentials for the Sparked account (for example
# AWS_PROFILE=csiro-fhir after `aws sso login`), jq, cmp.
#
# Never prints a file or secret value: comparisons use cmp on temporary files
# created with umask 077 and removed on exit.
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-2}"
TFVARS_SECRET="${SMILE_TFVARS_SECRET:-sparked/smile/terraform/sparkey-tfvars}"
BACKEND_SECRET="${SMILE_BACKEND_SECRET:-sparked/smile/terraform/backend-sparkey-hcl}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFVARS_FILE="$REPO_ROOT/tfvars/sparkey.tfvars"
BACKEND_FILE="$REPO_ROOT/terraform/backend-sparkey.hcl"

# Secrets Manager's limit for a secret value.
MAX_BYTES=65536

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

die() { echo "ERROR: $*" >&2; exit 1; }

CMD="fetch"
FORCE=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    fetch|status|push) CMD="$1" ;;
    --force) FORCE=1 ;;
    --yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

for tool in aws jq cmp; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
done

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fail early, with the reason, when there are no usable credentials.
aws sts get-caller-identity --region "$REGION" --query Arn --output text >/dev/null 2>"$TMP/sts.err" \
  || die "no AWS credentials ($(tr '\n' ' ' < "$TMP/sts.err")). Run: aws sso login --profile csiro-fhir; export AWS_PROFILE=csiro-fhir"

# get_stored SECRET OUTFILE: write the current secret value to OUTFILE byte for byte.
# jq -j adds no trailing newline, so a file pushed with file:// round-trips exactly.
# Returns 2 if the secret does not exist.
get_stored() {
  local secret="$1" out="$2"
  if ! aws secretsmanager get-secret-value --region "$REGION" --secret-id "$secret" \
        --output json > "$TMP/raw.json" 2>"$TMP/get.err"; then
    if grep -q ResourceNotFoundException "$TMP/get.err"; then
      rm -f "$TMP/raw.json"
      return 2
    fi
    rm -f "$TMP/raw.json"
    die "could not read $secret: $(tr '\n' ' ' < "$TMP/get.err")"
  fi
  jq -j '.SecretString' "$TMP/raw.json" > "$out"
  rm -f "$TMP/raw.json"
}

# describe SECRET: one line with the current version id and last change date.
describe() {
  aws secretsmanager describe-secret --region "$REGION" --secret-id "$1" --output json \
    | jq -r '"version " + ((.VersionIdsToStages // {}) | to_entries | map(select(.value | index("AWSCURRENT"))) | .[0].key // "none")
             + ", last changed " + ((.LastChangedDate // "unknown") | tostring)'
}

# ignored_name FILE TAG: FILE with TAG inserted before its extension, for example
# tfvars/sparkey.tfvars -> tfvars/sparkey.TAG.tfvars, which .gitignore still covers.
ignored_name() {
  local file="$1" tag="$2"
  echo "${file%.*}.$tag.${file##*.}"
}

fetch_one() {
  local secret="$1" file="$2" name stored
  name="${file#"$REPO_ROOT"/}"
  stored="$TMP/stored"
  if ! get_stored "$secret" "$stored"; then
    die "$secret does not exist yet. The first copy is created from a workstation that has the files (docs/smile-deploy-inputs.md, First-time setup)."
  fi
  [ -s "$stored" ] || die "$secret is empty; refusing to write an empty $name"

  if [ -f "$file" ]; then
    if cmp -s "$stored" "$file"; then
      chmod 600 "$file"
      echo "unchanged  $name (matches $secret)"
      rm -f "$stored"
      return 0
    fi
    if [ "$FORCE" -ne 1 ]; then
      rm -f "$stored"
      die "$name differs from $secret. If your local copy is the newer one, run 'push'; to discard it and take the stored copy, run 'fetch --force'."
    fi
    # Keep the extension last so the backup matches the same .gitignore rule
    # (*.tfvars, terraform/backend-*.hcl) as the file itself.
    local backup
    backup="$(ignored_name "$file" "bak-$(date +%Y%m%d%H%M%S)")"
    cp -p "$file" "$backup"
    chmod 600 "$backup"
    echo "backup     ${backup#"$REPO_ROOT"/} (your previous local copy)"
  fi

  mkdir -p "$(dirname "$file")"
  # Stage next to the target, under a gitignored name, so the mv is an atomic
  # rename and an interrupted run cannot leave a committable copy behind.
  local staged
  staged="$(ignored_name "$file" "tmp$$")"
  (set -o noclobber; cat "$stored" > "$staged")
  chmod 600 "$staged"
  mv -f "$staged" "$file"
  rm -f "$stored"
  echo "wrote      $name (0600, from $secret, $(describe "$secret"))"
}

status_one() {
  local secret="$1" file="$2" name stored rc=0
  name="${file#"$REPO_ROOT"/}"
  stored="$TMP/stored"
  get_stored "$secret" "$stored" || rc=$?
  if [ "$rc" -eq 2 ]; then
    echo "missing    $secret (not created yet)"
    return 0
  fi
  if [ ! -f "$file" ]; then
    echo "absent     $name (run fetch); stored $(describe "$secret")"
  elif cmp -s "$stored" "$file"; then
    echo "in sync    $name = $secret ($(describe "$secret"))"
  else
    echo "DIFFERENT  $name != $secret (stored $(describe "$secret"), local modified $(date -r "$file" '+%Y-%m-%d %H:%M'))"
  fi
  rm -f "$stored"
}

push_one() {
  local secret="$1" file="$2" name stored rc=0 bytes answer
  name="${file#"$REPO_ROOT"/}"
  [ -f "$file" ] || die "$name does not exist; nothing to push"
  bytes=$(wc -c < "$file" | tr -d ' ')
  [ "$bytes" -gt 0 ] || die "$name is empty; refusing to push"
  [ "$bytes" -le "$MAX_BYTES" ] || die "$name is $bytes bytes, over the Secrets Manager limit of $MAX_BYTES"

  stored="$TMP/stored"
  get_stored "$secret" "$stored" || rc=$?
  if [ "$rc" -eq 2 ]; then
    die "$secret does not exist yet; create it first (docs/smile-deploy-inputs.md, First-time setup)"
  fi
  if cmp -s "$stored" "$file"; then
    echo "unchanged  $name already matches $secret; nothing pushed"
    rm -f "$stored"
    return 0
  fi
  rm -f "$stored"

  if [ "$YES" -ne 1 ]; then
    printf 'Replace %s (%s) with local %s? [y/N] ' "$secret" "$(describe "$secret")" "$name"
    read -r answer
    case "$answer" in
      y|Y|yes) ;;
      *) echo "skipped    $name"; return 0 ;;
    esac
  fi
  # file:// sends the bytes as they are; the value never passes through the shell.
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$secret" \
    --secret-string "file://$file" --query VersionId --output text > "$TMP/version"
  echo "pushed     $name -> $secret (new version $(cat "$TMP/version"); the previous one is kept as AWSPREVIOUS)"
}

warn_autoloaded_tfvars() {
  # terraform/terraform.tfvars is auto-loaded on every run. sparkey.tfvars must
  # override every variable it sets (see sparkey.tfvars.example), so warn rather
  # than fail.
  if [ -f "$REPO_ROOT/terraform/terraform.tfvars" ]; then
    echo "note       terraform/terraform.tfvars exists and is auto-loaded by every terraform run;" \
         "it is a leftover of the destroyed dedicated-cluster stack and is not needed for sparkey"
  fi
}

case "$CMD" in
  fetch)
    fetch_one "$TFVARS_SECRET" "$TFVARS_FILE"
    fetch_one "$BACKEND_SECRET" "$BACKEND_FILE"
    warn_autoloaded_tfvars
    ;;
  status)
    status_one "$TFVARS_SECRET" "$TFVARS_FILE"
    status_one "$BACKEND_SECRET" "$BACKEND_FILE"
    warn_autoloaded_tfvars
    ;;
  push)
    push_one "$TFVARS_SECRET" "$TFVARS_FILE"
    push_one "$BACKEND_SECRET" "$BACKEND_FILE"
    ;;
esac
