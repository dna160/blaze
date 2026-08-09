#!/usr/bin/env bash
# BUILD-SPEC #50 — nightly logical dump of the RentOS Postgres database.
# Custom-format, compressed, portable (restorable to any Postgres, not tied to
# Railway's own tooling — the independent layer that survives a provider-level
# loss). Pair with Railway PITR for the low-RPO layer. See docs/RUNBOOK-BACKUP.md.
#
# Usage:  SOURCE_URL=postgres://user:pass@host:5432/rentos BACKUP_DIR=/var/backups/rentos ./dump.sh
set -euo pipefail

SOURCE_URL="${SOURCE_URL:-${DATABASE_URL:-}}"
if [[ -z "${SOURCE_URL}" ]]; then
  echo "ERROR: set SOURCE_URL (or DATABASE_URL) to the database to dump." >&2
  exit 2
fi
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAILY="${RETENTION_DAILY:-30}"

mkdir -p "${BACKUP_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/rentos-${STAMP}.dump"

echo "[dump] pg_dump → ${OUT}"
pg_dump --format=custom --no-owner --no-privileges --compress=9 --file="${OUT}" "${SOURCE_URL}"

# Integrity smoke check: the archive's TOC must be readable.
pg_restore --list "${OUT}" >/dev/null
echo "[dump] wrote and TOC-verified $(du -h "${OUT}" | cut -f1) ${OUT}"

# Retention: keep the newest N daily dumps, drop the rest.
mapfile -t OLD < <(ls -1t "${BACKUP_DIR}"/rentos-*.dump 2>/dev/null | tail -n "+$((RETENTION_DAILY + 1))")
if ((${#OLD[@]})); then
  printf '%s\n' "${OLD[@]}" | xargs -r rm -f
  echo "[dump] pruned ${#OLD[@]} dump(s) beyond retention ${RETENTION_DAILY}"
fi
