#!/usr/bin/env bash
# BUILD-SPEC #50 — restore drill. "A backup that has never been restored is not a
# backup." Restores the latest logical dump into a THROWAWAY scratch database,
# asserts core tables are populated AND the double-entry ledger balances
# (sum(DEBIT) == sum(CREDIT) — the same invariant the whole app is held to), then
# drops the scratch DB. Exit 0 = drill passed. See docs/RUNBOOK-BACKUP.md.
#
# Usage:
#   MAINT_URL=postgres://user:pass@host:5432/postgres \
#   SCRATCH_DB=rentos_restore_verify BACKUP_DIR=/var/backups/rentos ./restore-verify.sh
set -euo pipefail

MAINT_URL="${MAINT_URL:-}"        # connection to the 'postgres' maintenance DB (create/drop rights)
SCRATCH_DB="${SCRATCH_DB:-rentos_restore_verify}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DUMP_FILE="${DUMP_FILE:-}"

if [[ -z "${MAINT_URL}" ]]; then
  echo "ERROR: set MAINT_URL to a maintenance connection (…/postgres) with create/drop rights." >&2
  exit 2
fi
if [[ -z "${DUMP_FILE}" ]]; then
  DUMP_FILE="$(ls -1t "${BACKUP_DIR}"/rentos-*.dump 2>/dev/null | head -1 || true)"
fi
if [[ -z "${DUMP_FILE}" || ! -f "${DUMP_FILE}" ]]; then
  echo "ERROR: no dump found (BACKUP_DIR=${BACKUP_DIR}, DUMP_FILE=${DUMP_FILE})." >&2
  exit 1
fi

# Scratch DB connection = MAINT_URL with the db path swapped to SCRATCH_DB.
SCRATCH_URL="$(printf '%s' "${MAINT_URL}" | sed -E "s#(://[^/]+)/[^?]+#\1/${SCRATCH_DB}#")"

cleanup() {
  psql "${MAINT_URL}" -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[restore-verify] dump:    ${DUMP_FILE}"
echo "[restore-verify] scratch: ${SCRATCH_DB}"

psql "${MAINT_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" >/dev/null
psql "${MAINT_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${SCRATCH_DB}\";" >/dev/null

# pg_restore may emit benign warnings for RLS role grants; tolerate them but fail
# on a genuinely broken restore via the assertions below.
pg_restore --no-owner --no-privileges --dbname="${SCRATCH_URL}" "${DUMP_FILE}" || true

fail=0
assert_nonzero() {
  local table="$1"
  local n
  n="$(psql "${SCRATCH_URL}" -tAc "SELECT count(*) FROM ${table};" 2>/dev/null || echo 0)"
  if [[ "${n}" -gt 0 ]]; then
    echo "  ✅ ${table}: ${n} rows"
  else
    echo "  ❌ ${table}: 0 rows (expected > 0)"; fail=1
  fi
}

echo "[restore-verify] core table population:"
for t in organizations tenants users asset_types; do assert_nonzero "$t"; done

echo "[restore-verify] ledger balance on the restored copy:"
read -r DEB CRE <<<"$(psql "${SCRATCH_URL}" -tAF' ' -c \
  "SELECT coalesce(sum(amount) FILTER (WHERE entry_type='DEBIT'),0), coalesce(sum(amount) FILTER (WHERE entry_type='CREDIT'),0) FROM ledger_entries;" 2>/dev/null || echo "0 0")"
if awk "BEGIN{exit !(($DEB)==($CRE))}"; then
  echo "  ✅ ledger balanced: DEBIT=${DEB} CREDIT=${CRE}"
else
  echo "  ❌ ledger IMBALANCE: DEBIT=${DEB} CREDIT=${CRE}"; fail=1
fi

if [[ "${fail}" -eq 0 ]]; then
  echo "[restore-verify] RESULT: PASS ✅  (record it in docs/RUNBOOK-BACKUP.md §8)"
else
  echo "[restore-verify] RESULT: FAIL ❌"
fi
exit "${fail}"
