#!/usr/bin/env bash
# Removes the local proof stack and its volumes. Nothing in it is meant to
# outlive a recording session.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/infra"
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo down -v --remove-orphans
