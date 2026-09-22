#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Brings up the local proof stack: n8n, Postgres and the mock provider server,
# loads the ops schema, imports the four workflow files with the n8n CLI, and
# attaches credentials so the workflows can be executed for real.
#
#   scripts/demo-up.sh
#
# Then: node scripts/run-scenarios.mjs
# Tear down with: scripts/demo-down.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/infra"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo)

# The mock Slack listener needs a certificate, because n8n's Slack node insists
# on https://slack.com/api and the demo maps that name to the mock container.
if [[ ! -f "$ROOT/mocks/tls/mock.crt" ]]; then
  echo "==> generating a self-signed certificate for the mock Slack listener"
  mkdir -p "$ROOT/mocks/tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout "$ROOT/mocks/tls/mock.key" -out "$ROOT/mocks/tls/mock.crt" \
    -subj "/CN=slack.com" \
    -addext "subjectAltName=DNS:slack.com,DNS:mock,IP:172.28.10.10" 2>/dev/null
fi

echo "==> starting postgres, n8n and the mock provider (caddy is not used locally)"
"${COMPOSE[@]}" up -d postgres n8n mock

echo "==> waiting for n8n"
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:5678/healthz >/dev/null; then break; fi
  sleep 2
done
curl -sf http://127.0.0.1:5678/healthz >/dev/null || { echo "n8n did not become healthy"; exit 1; }

echo "==> loading sql/schema.sql into the revenue_ops database"
"${COMPOSE[@]}" exec -T -e PGPASSWORD=local-demo-password postgres \
  psql -U n8n -d revenue_ops -v ON_ERROR_STOP=1 -q < "$ROOT/sql/schema.sql"

echo "==> importing workflows/ with the n8n CLI"
"${COMPOSE[@]}" exec -T n8n n8n import:workflow --separate --input=/workflows

echo "==> creating credentials, setting the error workflow, activating"
node "$ROOT/scripts/configure-n8n.mjs"

echo "==> adding the shortened-wait copy of workflow 02 used by the dunning scenario"
node "$ROOT/scripts/make-dunning-demo.mjs"

echo
echo "n8n editor : http://localhost:5678  (demo@localhost.test / DemoRun-2026!x)"
echo "mock server: http://localhost:4100/__control/state"
echo "postgres   : psql postgres://n8n:local-demo-password@127.0.0.1:15678/revenue_ops"
