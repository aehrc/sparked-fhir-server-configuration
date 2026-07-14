# Aurora PostgreSQL 14 to 16 upgrade plan

Upgrade the `SmileCluster` Aurora PostgreSQL Serverless v2 cluster from engine
`14.20` to `16.x`, in place, through the existing gated terraform pipeline. Prepared
2026-07-14; execute in a quiet window.

Why: Smile CDR 2026.05 recommends PostgreSQL 16 (14 is merely supported), community
PostgreSQL 14 reaches EOL in November 2026 (after which RDS extended-support billing
applies), and PG16 unlocks Aurora Serverless v2 scale-to-zero as an optional
follow-up saving.

## Current state (verified 2026-07-14)

| Item | Value |
|---|---|
| Cluster | `smile-smilecluster-dff66d5832d6f1c8`, engine `14.20`, one `db.serverless` instance |
| Scaling | 0.5 to 4 ACU |
| Parameter groups | `default.aurora-postgresql14` on cluster and instance (defaults, no custom PG to migrate) |
| Backup retention | 1 day (so a manual pre-upgrade snapshot is essential) |
| Valid in-place targets from 14.20 | `16.11`, `16.13` (re-check on the day, see below) |
| Terraform | `db_instances[0].engine_version = "14.20"` in `terraform/main.tf`; module `sdh-deps` v9.0.2 passes through `allow_major_version_upgrade` and `apply_immediately` per instance |
| Databases | clustermgr, persistence, aucore, hl7au, ereq, audit, transaction (one cluster, seven DBs/users) |

Smile CDR side: nothing changes. The JDBC config (`db.driver: POSTGRES_9_4`,
`sslmode=require`) is unaffected; no Smile schema migration runs, this is a database
engine upgrade only.

## Approach decision

In-place major version upgrade via terraform (recommended for this environment):
one PR, one gated apply, roughly 10 to 15 minutes of database unavailability while
Aurora runs pg_upgrade. RDS Blue/Green would cut that to about a minute of
switchover but temporarily doubles the cluster, complicates terraform state, and is
overkill for a test/connectathon server; noted and rejected.

Because the cluster uses default parameter groups, AWS attaches
`default.aurora-postgresql16` automatically during the upgrade.

## Runbook

### Step 0: pre-flight (no changes)

1. Pick a quiet window (roughly 20 to 30 minutes of API downtime end to end) and
   notify participants.
2. Re-check the latest valid 16.x target from the live version:

   ```bash
   aws rds describe-db-engine-versions --engine aurora-postgresql \
     --engine-version "$(aws rds describe-db-clusters \
       --db-cluster-identifier smile-smilecluster-dff66d5832d6f1c8 \
       --query 'DBClusters[0].EngineVersion' --output text)" \
     --query "DBEngineVersions[0].ValidUpgradeTarget[?starts_with(EngineVersion,'16')].EngineVersion"
   ```

   Use the highest listed (16.13 as of 2026-07-14). If AWS auto-minor-upgraded the
   cluster past 14.20 since this plan was written, update the `engine_version` the
   PR replaces as well; the pin must always match the live version before the
   change.
3. Manual cluster snapshot (the rollback anchor; retention is only 1 day otherwise):

   ```bash
   aws rds create-db-cluster-snapshot \
     --db-cluster-identifier smile-smilecluster-dff66d5832d6f1c8 \
     --db-cluster-snapshot-identifier smile-pre-pg16-$(date +%Y%m%d) \
     --tags Key=Purpose,Value=aurora-pg16-upgrade-rollback
   aws rds wait db-cluster-snapshot-available \
     --db-cluster-snapshot-identifier smile-pre-pg16-$(date +%Y%m%d)
   ```

   Wait for `available` before proceeding.
4. Baseline smoke run: `./scripts/upgrade_smoke_tests.sh -o pg16-baseline.md`.

### Step 1: the PR (one file, terraform/main.tf)

In `db_instances[0]`:

```hcl
# In-place major upgrade to PostgreSQL 16 (Smile CDR 2026.05 recommends 16;
# PG14 community EOL is 2026-11). allow_major_version_upgrade and
# apply_immediately are required for the engine change to run at apply time
# rather than waiting for the maintenance window; both are safe to leave set.
engine_version              = "16.13"
allow_major_version_upgrade = true
apply_immediately           = true
```

Review the plan comment on the PR: expect an in-place update of the RDS cluster
(and instance) resources only; no destroy/replace, no helm changes. A plan showing
replacement means STOP (the pin/live mismatch trap described in the existing
comment above `engine_version`).

### Step 2: quiesce Smile CDR (optional but recommended)

Aurora is unavailable mid-upgrade; Smile pods would otherwise log connection-error
noise and may crash/restart on their own (they self-heal, so skipping this step is
survivable). Cleaner:

```bash
kubectl scale deploy -n smile --replicas=0 \
  smilecdr-scdrnode-aucore smilecdr-scdrnode-ereq smilecdr-scdrnode-hl7au
```

### Step 3: merge + gated apply

Merge the PR, then dispatch `Smile Configuration Deployment` with `confirm_apply:
APPLY`. The apply blocks while Aurora upgrades (roughly 10 to 15 minutes). Track
engine status in parallel:

```bash
watch -n 20 "aws rds describe-db-clusters \
  --db-cluster-identifier smile-smilecluster-dff66d5832d6f1c8 \
  --query 'DBClusters[0].[Status,EngineVersion]' --output text"
```

### Step 4: restore service and post-upgrade tasks

1. Scale the nodes back (if quiesced): `kubectl scale deploy -n smile --replicas=1 ...`
   and wait for `kubectl rollout status` on all three.
2. Refresh optimizer statistics (pg_upgrade does not carry them; first queries are
   slow otherwise). Run ANALYZE per database from a throwaway psql pod using the
   module-created credentials secrets (`smile-smilecluster-<user>` in the `smile`
   namespace), for each of the seven databases:

   ```bash
   kubectl run pg-analyze --rm -it --restart=Never -n smile --image=postgres:16 \
     --env="PGPASSWORD=$(kubectl get secret -n smile smile-smilecluster-persistence -o jsonpath='{.data.password}' | base64 -d)" \
     -- psql "host=<cluster-endpoint> dbname=persistence user=persistence sslmode=require" -c "ANALYZE VERBOSE;"
   ```

   (Repeat for clustermgr, aucore, hl7au, ereq, audit, transaction; check the
   secret key names with `kubectl describe secret` first, they may be `username`/
   `password` or a connection JSON.) If pod networking to RDS is restricted, run
   ANALYZE from any pod in the smile namespace instead; the Smile pods' env vars
   (e.g. `AUCORE_DB_URL`) carry the endpoint.
3. Full verification: `./scripts/upgrade_smoke_tests.sh --expect-version 2026.05.R01
   -o pg16-post.md` and diff against the baseline (expect identical results; the
   known hl7au smartauth 404 remains).
4. Confirm the live engine reads 16.x and terraform is clean: re-run the plan-only
   workflow (push to main runs plan automatically) and expect no changes.

### Rollback

There is no engine downgrade. If the upgrade fails mid-flight, Aurora rolls the
cluster back to 14 itself in most failure modes. If PG16 misbehaves after success,
restore path:

1. Restore the snapshot to a new cluster
   (`aws rds restore-db-cluster-from-snapshot`, engine 14.20), add a
   `db.serverless` instance.
2. Repoint Smile CDR by updating the DB endpoint values (the module wires endpoints
   via env vars from its secrets; easiest is restoring under the original
   identifier after renaming the failed cluster).
3. Any data written after the snapshot is lost; decide quickly.

This is deliberately heavyweight; the mitigation is the pre-flight snapshot plus
verifying on the smoke suite immediately.

## Follow-up unlocked by PG16 (optional, separate PR)

Aurora Serverless v2 on recent PG16 supports scale-to-zero (`min_capacity = 0`,
auto-pause after idle). For a test server that idles overnight this is a real
saving (0.5 ACU floor is currently billed around the clock). Cold-start on first
request after pause is roughly 15 seconds. Verify the module passes
`serverless_configuration.min_capacity = 0` through cleanly and that the deployed
engine version supports auto-pause before proposing.

## Out of scope

- RDS Blue/Green switchover (rejected above).
- Custom parameter groups (none in use).
- Any Smile CDR configuration change (none needed).
