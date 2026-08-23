#!/usr/bin/env bash
# Emulates `prisma migrate deploy` using plain psql — for sandboxes where
# Prisma's schema-engine binary can't be downloaded (binaries.prisma.sh
# blocked). Applies every not-yet-applied migration in
# packages/database/prisma/migrations in name order and records it in
# _prisma_migrations with the same shape Prisma uses, so a later real
# `prisma migrate deploy` (e.g. on Railway) sees them as already applied.
#
# Usage: DATABASE_URL=postgresql://... scripts/migrate-deploy-psql.sh
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required (the OWNER/migrator role, not rentos_app)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIG_DIR="$ROOT/packages/database/prisma/migrations"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  id VARCHAR(36) PRIMARY KEY,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
);
SQL

for dir in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$dir")"
  file="$dir/migration.sql"
  [ -f "$file" ] || continue
  applied="$(psql "$DATABASE_URL" -tAq -c "SELECT 1 FROM _prisma_migrations WHERE migration_name = '$name' AND finished_at IS NOT NULL LIMIT 1")"
  if [ "$applied" = "1" ]; then
    echo "skip    $name (already applied)"
    continue
  fi
  checksum="$(sha256sum "$file" | cut -d' ' -f1)"
  id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  echo "apply   $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at) VALUES ('$id', '$checksum', '$name', now())"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "UPDATE _prisma_migrations SET finished_at = now(), applied_steps_count = 1 WHERE id = '$id'"
done
echo "done"
