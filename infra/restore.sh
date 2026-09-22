#!/usr/bin/env bash
#
# Restore a backup produced by backup.sh.
#
#   ./restore.sh /var/backups/n8n/n8n-2026-09-21T17-15-00Z.tar.gz
#
# This is destructive: it drops and recreates both databases and replaces the
# n8n data volume. It refuses to run without --yes, and it always prints what
# it is about to overwrite first.
#
# Run it on a scratch host once a month. A backup you have never restored is a
# hypothesis, not a backup - the two things that usually go wrong are a missing
# N8N_ENCRYPTION_KEY (every credential comes back unreadable) and a dump that
# has been zero bytes for six weeks.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

ARCHIVE="${1:-}"
CONFIRM="${2:-}"

usage() {
  cat <<'USAGE'
Usage: ./restore.sh <archive.tar.gz> [--yes]

  archive.tar.gz   an archive written by backup.sh
  --yes            skip the interactive confirmation (for scripted drills)

The stack must already exist (docker compose up -d has been run at least once)
so that the volumes and the Postgres container are present.
USAGE
}

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "restore: no env file at $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${POSTGRES_USER:?POSTGRES_USER is not set}"
: "${POSTGRES_DB:?POSTGRES_DB is not set}"
: "${REVENUE_OPS_DB:?REVENUE_OPS_DB is not set}"

COMPOSE=(docker compose --project-directory "$SCRIPT_DIR" --env-file "$ENV_FILE")

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log "unpacking $ARCHIVE"
tar xzf "$ARCHIVE" -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)"

if [[ -z "$SRC" ]]; then
  echo "restore: archive does not contain a backup directory" >&2
  exit 1
fi

echo
echo "About to restore from:"
sed 's/^/    /' "$SRC/MANIFEST" 2>/dev/null || echo "    (no MANIFEST in this archive)"
echo
echo "This will DROP and recreate:  $POSTGRES_DB, $REVENUE_OPS_DB"
echo "and replace the contents of:  the n8n_data volume"
echo

if [[ "$CONFIRM" != "--yes" ]]; then
  read -r -p "Type the word restore to continue: " answer
  if [[ "$answer" != "restore" ]]; then
    echo "aborted"
    exit 1
  fi
fi

# --- compare the encryption keys -------------------------------------------
# If the key in the backup differs from the key in the current .env, the
# credentials will restore as undecryptable ciphertext. Say so now.
if [[ -f "$SRC/env.snapshot" ]]; then
  backed_up_key="$(grep -E '^N8N_ENCRYPTION_KEY=' "$SRC/env.snapshot" | cut -d= -f2- || true)"
  if [[ -n "$backed_up_key" && "$backed_up_key" != "${N8N_ENCRYPTION_KEY:-}" ]]; then
    echo
    echo "WARNING: N8N_ENCRYPTION_KEY in this backup does not match the one in $ENV_FILE."
    echo "Restoring as-is will leave every stored credential unreadable."
    echo "Use the key from $SRC/env.snapshot in your .env before continuing."
    if [[ "$CONFIRM" != "--yes" ]]; then
      read -r -p "Continue anyway? [y/N] " k
      [[ "$k" == "y" || "$k" == "Y" ]] || exit 1
    fi
  fi
fi

# --- stop the app, leave the database up ------------------------------------
log "stopping n8n (postgres stays up to take the restore)"
"${COMPOSE[@]}" stop n8n || true
"${COMPOSE[@]}" stop n8n-worker 2>/dev/null || true
"${COMPOSE[@]}" up -d postgres
"${COMPOSE[@]}" exec -T postgres sh -c 'until pg_isready -q; do sleep 1; done'

# --- databases --------------------------------------------------------------
restore_db() {
  local db="$1" dump="$2"

  if [[ ! -s "$dump" ]]; then
    log "no dump for $db at $dump - skipping"
    return
  fi

  log "recreating $db"
  "${COMPOSE[@]}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS \"$db\";" \
    -c "CREATE DATABASE \"$db\" OWNER \"$POSTGRES_USER\";"

  log "restoring $db"
  "${COMPOSE[@]}" exec -T postgres \
    pg_restore -U "$POSTGRES_USER" -d "$db" --no-owner --no-privileges --exit-on-error \
    < "$dump"
}

restore_db "$POSTGRES_DB"     "$SRC/n8n-$POSTGRES_DB.dump"
restore_db "$REVENUE_OPS_DB"  "$SRC/revenue-ops-$REVENUE_OPS_DB.dump"

# --- n8n data volume --------------------------------------------------------
if [[ -s "$SRC/n8n-data.tar.gz" ]]; then
  log "replacing the n8n data volume"
  docker run --rm \
    -v n8n-revenue_n8n_data:/data \
    -v "$SRC":/backup:ro \
    alpine:3.20 \
    sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/n8n-data.tar.gz -C /data'
else
  log "no n8n-data.tar.gz in this archive - leaving the volume alone"
fi

log "starting n8n"
"${COMPOSE[@]}" up -d

cat <<'NEXT'

Restore finished. Verify before you call it done:

  1. Open the editor and confirm the workflow list and their active states.
  2. Open one credential. If it shows its fields, the encryption key matched.
     If it shows an error, your .env has the wrong N8N_ENCRYPTION_KEY.
  3. Run workflow 04 manually. It touches Postgres, the payment API, Thinkific
     and Slack, so it exercises every credential in the stack in one go.
  4. Re-send one payment webhook from the provider dashboard and confirm the
     idempotency ledger records it exactly once.

NEXT
