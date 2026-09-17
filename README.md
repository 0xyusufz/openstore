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

Coordinator refreshes are coalesced and a failed refresh never replaces a
known-good snapshot. New uploads require a fresh coordinator response before
placing replicas. Downloads and deletes of an existing manifest may continue
using only its recorded replica identities during an outage; they never add
replacement replicas. Discovery refreshes are likewise safe to trigger
immediately (`refreshNow()`) or on a schedule, with bounded duplicate-dial
suppression.

## Backup and recovery foundation

`npm run backup -- create` creates a versioned directory backup without
decrypting or interpreting any stored data. The client keystore, manifests,
operation records, and optional web DEK vault should be backed up together.
For a storage node, always back up its encrypted identity and the complete
piece directory (including `.provenance`) together; never mix those from
different nodes. The coordinator registry is an independent component.

Stop or quiesce the relevant client, coordinator, or storage node before
backing it up. This version does not provide a transactional live snapshot.
Backups contain opaque encrypted bytes and metadata only; recovery phrases,
passwords, coordinator tokens, private keys in plaintext, and plaintext file
contents are never included.

Example:

```sh
npm run backup -- create --destination ./backup-2026-09-17 \
  --client-keystore ./openstore-identity.json \
  --client-manifests ./openstore-manifests \
  --client-operations ./openstore-manifests/.provenance-operations \
  --client-dek ./web-vault.deks.json
npm run backup -- verify --backup ./backup-2026-09-17
npm run backup -- restore --backup ./backup-2026-09-17 \
  --destination ./restored-state
```

Backup creation refuses existing destinations by default. Restore refuses
non-empty destinations unless `--replace` is explicitly supplied, validates
all SHA-256 checksums before staging, rejects symlinks and unsafe paths, and
never extracts outside the selected destination. Losing the encrypted client
keystore can make encrypted files unrecoverable even when storage replicas
still exist. Backups should be verified regularly and retained according to
the operator's recovery objectives; no backup guarantees protection from every
filesystem, device, or operator failure.

## Metrics foundation

Coordinator instances expose a sanitized JSON snapshot at `GET /v1/metrics`
(and `/metrics`). Storage nodes and clients use the same lightweight
`MetricsRegistry` abstraction in `packages/metrics`; callers may inject a
registry to inspect process-local metrics. The coordinator snapshot includes
request/error counts, registration and heartbeat activity, expiry activity,
capacity/persistence gauges, and request timings. Storage-node metrics cover
bounded operation counts, rejections, capacity, draining state, and timings.
Client, repair, and orphan-scanner boundaries record aggregate operation,
retry, replica-failure, repair, and cleanup activity.

Metric names use lowercase `snake_case`. Labels are restricted to a small
allowlist of operation, route, result, status class, transport, and reason
values; IDs, filenames, URLs, tokens, keys, plaintext, ciphertext, and
recovery material are never labels. The registry has a bounded series limit
and rejects invalid names/labels. Metrics are process-local and reset on
restart; this milestone provides no durable storage, alerting, dashboard, or
Prometheus/OpenTelemetry exporter. The unauthenticated coordinator endpoint
is intended for the local/testnet boundary and must not be exposed directly
to an untrusted network.

## Operational events

Coordinator, storage-node, client, repair, and orphan-cleanup boundaries can
emit a versioned operational event stream backed by a bounded, process-local
buffer. Events are sanitized through an allowlisted detail schema and retain
only aggregate lifecycle, failure, retry, and scan information; sensitive
material, identifiers, paths, URLs, request bodies, and raw errors are
rejected. The coordinator exposes the bounded authenticated snapshot at
`GET /v1/events` (or `/events`).

The buffer defaults to 1,000 events, evicts the oldest entries
deterministically, and resets on process restart. There is no durable event
log, alerting, dashboard, or external exporter in this milestone.

## Operational diagnostics

Coordinator and storage-node status surfaces expose aggregate-only diagnostics:
capacity usage, available capacity, piece counts, draining/health state,
bounded request metrics, scheduler state, and recent sanitized operational
events. Repair and orphan-cleanup activity is represented by bounded counters,
gauges, timings, and lifecycle events; no per-piece or per-node history is
returned.

Diagnostics are process-local and reset on restart. Recent events and metrics
are bounded, immutable snapshots with no durable history, alerting, dashboard,
database, or external monitoring exporter. Sensitive identifiers, paths,
credentials, keys, plaintext, ciphertext, and raw errors are never exposed.
