#!/bin/sh
set -eu

: "${OPENSTORE_NODE_PASSWORD:?OPENSTORE_NODE_PASSWORD is required}"
: "${OPENSTORE_COORDINATOR_TOKEN:?OPENSTORE_COORDINATOR_TOKEN is required}"
: "${OPENSTORE_NODE_IDENTITY:?OPENSTORE_NODE_IDENTITY is required}"
: "${OPENSTORE_NODE_STORAGE:?OPENSTORE_NODE_STORAGE is required}"

mkdir -p "$(dirname "$OPENSTORE_NODE_IDENTITY")" "$OPENSTORE_NODE_STORAGE"
chmod 0700 "$(dirname "$OPENSTORE_NODE_IDENTITY")" "$OPENSTORE_NODE_STORAGE"

if [ ! -e "$OPENSTORE_NODE_IDENTITY" ]; then
  umask 077
  node --input-type=module -e '
    import { createIdentity } from "/app/dist/packages/identity/index.js";
    import { saveIdentity } from "/app/dist/packages/identity/keystore.js";
    await saveIdentity(
      createIdentity(),
      process.env.OPENSTORE_NODE_PASSWORD,
      process.env.OPENSTORE_NODE_IDENTITY
    );
  '
fi

CONFIG_ARGS=
if [ -n "${OPENSTORE_NODE_CONFIG:-}" ]; then
  CONFIG_ARGS="--config"
fi

if [ -n "$CONFIG_ARGS" ]; then
  exec node /app/dist/apps/storage-node/libp2p-cli.js \
  "$CONFIG_ARGS" "$OPENSTORE_NODE_CONFIG" \
  --storage-dir "$OPENSTORE_NODE_STORAGE" \
  --identity "$OPENSTORE_NODE_IDENTITY" \
  --password-env OPENSTORE_NODE_PASSWORD \
  --listen "/ip4/0.0.0.0/tcp/${OPENSTORE_NODE_INTERNAL_PORT:-4101}" \
  --advertise "$OPENSTORE_NODE_ADVERTISED_ADDR" \
  --capacity-bytes "${OPENSTORE_NODE_CAPACITY_BYTES:-1073741824}" \
  --max-piece-bytes "${OPENSTORE_NODE_MAX_PIECE_BYTES:-4194304}" \
  --coordinator-url "${OPENSTORE_COORDINATOR_URL:-http://coordinator:4190}" \
  --coordinator-token-env OPENSTORE_COORDINATOR_TOKEN \
  --heartbeat-interval-ms "${OPENSTORE_NODE_HEARTBEAT_INTERVAL_MS:-500}"
fi

exec node /app/dist/apps/storage-node/libp2p-cli.js \
  --storage-dir "$OPENSTORE_NODE_STORAGE" \
  --identity "$OPENSTORE_NODE_IDENTITY" \
  --password-env OPENSTORE_NODE_PASSWORD \
  --listen "/ip4/0.0.0.0/tcp/${OPENSTORE_NODE_INTERNAL_PORT:-4101}" \
  --advertise "$OPENSTORE_NODE_ADVERTISED_ADDR" \
  --capacity-bytes "${OPENSTORE_NODE_CAPACITY_BYTES:-1073741824}" \
  --max-piece-bytes "${OPENSTORE_NODE_MAX_PIECE_BYTES:-4194304}" \
  --coordinator-url "${OPENSTORE_COORDINATOR_URL:-http://coordinator:4190}" \
  --coordinator-token-env OPENSTORE_COORDINATOR_TOKEN \
  --heartbeat-interval-ms "${OPENSTORE_NODE_HEARTBEAT_INTERVAL_MS:-500}"
