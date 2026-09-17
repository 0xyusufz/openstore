#!/bin/sh
set -eu

mkdir -p "$(dirname "$OPENSTORE_COORDINATOR_PERSISTENCE")"
exec node /app/dist/apps/registry/coordinator-cli.js \
  --port "${OPENSTORE_COORDINATOR_PORT:-4190}" \
  --host "${OPENSTORE_COORDINATOR_HOST:-0.0.0.0}" \
  --persistence "$OPENSTORE_COORDINATOR_PERSISTENCE" \
  --heartbeat-timeout-ms "${OPENSTORE_COORDINATOR_HEARTBEAT_TIMEOUT_MS:-3000}" \
  --token-env OPENSTORE_COORDINATOR_TOKEN
