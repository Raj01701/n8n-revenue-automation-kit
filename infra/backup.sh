#!/usr/bin/env bash
#
# Nightly backup of the n8n stack.
#
# Produces one dated directory containing:
#   n8n-<db>.dump        pg_dump custom format - n8n's workflows, credentials,
#                        execution history
#   revenue-ops-<db>.dump  pg_dump custom format - the tables in sql/schema.sql
#   n8n-data.tar.gz      the /home/node/.n8n volume (config, SSH keys, binary
#                        data written by executions)
#   env.snapshot         a copy of .env, because N8N_ENCRYPTION_KEY is what
#                        makes the credentials in the dump readable again
#   MANIFEST             sizes, checksums and the image versions in use
#
# Then tars the directory, removes the working copy, and deletes archives older
# than BACKUP_RETENTION_DAYS.
#
# Usage:
#   ./backup.sh                 # uses ./.env
#   ENV_FILE=/path/.env ./backup.sh
#
# Cron (run it as a user that can talk to Docker):
#   15 3 * * * /opt/n8n/infra/backup.sh >> /var/log/n8n-backup.log 2>&1
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "backup: no env file at $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${POSTGRES_USER:?POSTGRES_USER is not set}"
: "${POSTGRES_DB:?POSTGRES_DB is not set}"
: "${REVENUE_OPS_DB:?REVENUE_OPS_DB is not set}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/n8n}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORK="$BACKUP_DIR/n8n-$STAMP"
ARCHIVE="$BACKUP_DIR/n8n-$STAMP.tar.gz"

COMPOSE=(docker compose --project-directory "$SCRIPT_DIR" --env-file "$ENV_FILE")

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

cleanup_on_failure() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    log "FAILED with exit code $code - removing the partial backup"
    rm -rf "$WORK" "$ARCHIVE"
  fi
  exit $code
}
trap cleanup_on_failure EXIT

mkdir -p "$WORK"
log "backing up into $WORK"

# --- databases --------------------------------------------------------------
# Custom format (-Fc) rather than plain SQL: it restores selectively, restores
# in parallel, and is compressed on the way out.
log "dumping $POSTGRES_DB"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges \
  > "$WORK/n8n-$POSTGRES_DB.dump"

log "dumping $REVENUE_OPS_DB"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$REVENUE_OPS_DB" -Fc --no-owner --no-privileges \
  > "$WORK/revenue-ops-$REVENUE_OPS_DB.dump"

# A zero-byte dump means the command failed inside the container while the pipe
# still succeeded. Catch it here rather than on the night you need to restore.
for dump in "$WORK"/*.dump; do
  if [[ ! -s "$dump" ]]; then
    log "dump $dump is empty"
    exit 1
  fi
done

# --- n8n data volume --------------------------------------------------------
# Read straight out of the named volume with a throwaway container, so this
# works the same whether or not n8n is running.
log "archiving the n8n data volume"
docker run --rm \
  -v n8n-revenue_n8n_data:/data:ro \
  -v "$WORK":/backup \
  alpine:3.20 \
  tar czf /backup/n8n-data.tar.gz -C /data .

# --- the encryption key -----------------------------------------------------
# Without N8N_ENCRYPTION_KEY the credentials inside the database dump are
# ciphertext you cannot open. The backup is only complete with it.
cp "$ENV_FILE" "$WORK/env.snapshot"
chmod 600 "$WORK/env.snapshot"

# --- manifest ---------------------------------------------------------------
{
  echo "created_utc=$STAMP"
  echo "host=$(hostname)"
  echo "n8n_image=$("${COMPOSE[@]}" config --images | grep -m1 n8n || echo unknown)"
  echo "postgres_db=$POSTGRES_DB"
  echo "revenue_ops_db=$REVENUE_OPS_DB"
  echo "---"
  ls -l "$WORK"
  echo "---"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$WORK" && sha256sum ./*)
  else
    (cd "$WORK" && shasum -a 256 ./*)
  fi
} > "$WORK/MANIFEST"

# --- pack and prune ---------------------------------------------------------
log "packing $ARCHIVE"
tar czf "$ARCHIVE" -C "$BACKUP_DIR" "$(basename "$WORK")"
chmod 600 "$ARCHIVE"
rm -rf "$WORK"

log "pruning archives older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -name 'n8n-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete

log "done: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
log "copy it off this machine, and restore it somewhere every month - see restore.sh"
