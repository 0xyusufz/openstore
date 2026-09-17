#!/bin/sh
set -eu

mkdir -p "$(dirname "$OPENSTORE_COORDINATOR_PERSISTENCE")"
chmod 0700 "$(dirname "$OPENSTORE_COORDINATOR_PERSISTENCE")"
chown -R openstore:openstore "$(dirname "$OPENSTORE_COORDINATOR_PERSISTENCE")"
exec gosu openstore node /app/dist/apps/registry/coordinator-cli.js \
  --port "${OPENSTORE_COORDINATOR_PORT:-4190}" \
  --host "${OPENSTORE_COORDINATOR_HOST:-0.0.0.0}" \
  --persistence "$OPENSTORE_COORDINATOR_PERSISTENCE" \
  --heartbeat-timeout-ms "${OPENSTORE_COORDINATOR_HEARTBEAT_TIMEOUT_MS:-3000}" \
  --token-env OPENSTORE_COORDINATOR_TOKEN
