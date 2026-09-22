#!/bin/sh
# Runs once, on the first boot of an empty postgres_data volume.
#
# n8n gets its own database (POSTGRES_DB, created by the base image) and the
# workflows get a second one (REVENUE_OPS_DB) for the tables in sql/schema.sql.
# Keeping them apart means you can reload the ops schema without touching n8n's
# credentials, executions or workflow history.
set -eu

: "${REVENUE_OPS_DB:?REVENUE_OPS_DB must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
  SELECT 'CREATE DATABASE ${REVENUE_OPS_DB}'
   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${REVENUE_OPS_DB}')\gexec
SQL

echo "init: ${REVENUE_OPS_DB} is ready. Load the tables with:"
echo "  docker compose exec -T postgres psql -U ${POSTGRES_USER} -d ${REVENUE_OPS_DB} < ../sql/schema.sql"
