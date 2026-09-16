# openstore
Open-source decentralized encrypted storage network.

## Standalone libp2p storage node

The HTTP storage-node runtime remains available through the existing APIs. For
a separate libp2p process, create an encrypted identity keystore and run:

```sh
npm run storage-node -- --storage-dir ./pieces \
  --identity ./openstore-identity.json --password-env OPENSTORE_PASSWORD \
  --listen /ip4/127.0.0.1/tcp/4102 \
  --capacity-bytes 1073741824 --refresh-interval-ms 5000
```

`--listen` may be repeated with libp2p multiaddrs. DHT bootstrap descriptors
can be supplied with `--bootstrap <json-file>`; descriptors are validated and
must contain an identity binding. The process logs only its peer ID and listen
addresses, and shuts down cleanly on SIGINT/SIGTERM. Piece data is opaque,
validated for safe IDs, persisted under `--storage-dir`, and constrained by
the configured capacity when using the runtime API.

For non-CLI configuration, `--config <json-file>` accepts the same runtime
fields: `storageDir`, `identityPath`, `identityPassword`, `listenAddrs`,
`bootstrapPeers`, `capacityBytes`, `maxPieceBytes`, and
`discoveryRefreshIntervalMs`, `coordinatorUrl`, `coordinatorToken`, and
`heartbeatIntervalMs`. Prefer `--password-env` for interactive launches.
To register directly with a separate coordinator, set `coordinatorUrl` and
optionally `coordinatorToken` (or use `--coordinator-url` and
`--coordinator-token-env`); `heartbeatIntervalMs` controls signed
libp2p registration heartbeats.
so the password is not present in the process command line.

## Trusted registry coordinator

The registry can run as a separate, loopback-only coordinator process. Node
processes send signed JSON envelopes; private keys never cross the process
boundary and the coordinator validates signatures, replay protection,
heartbeats, expiry, and self-removal through the same `Registry` implementation:

```sh
OPENSTORE_COORDINATOR_TOKEN="$(openssl rand -hex 24)" \
  npm run registry -- --port 4190 --token-env OPENSTORE_COORDINATOR_TOKEN
```

The versioned protocol is available at `GET /v1/health`, `GET /v1/nodes` and
`POST /v1/register`, `/v1/heartbeat`, `/v1/unregister`. Set the same bearer
token on node clients (`createRegistryClient`) when coordinator authentication
is enabled. The coordinator supports an optional persistence file and retains
HTTP and libp2p records in the same placement snapshot.

`GET /v1/status` (and `/v1/health`) includes a sanitized aggregate snapshot:
node availability, capacity totals, and average health scores. Applications
can enable the coordinator-owned expiry worker with `expiryIntervalMs` and
`startExpiryWorker: true`, or control it explicitly with
`startExpiryWorker()`/`stopExpiryWorker()`. Client adapters retain their
last-known-good endpoint snapshot and expose non-secret refresh metadata.
