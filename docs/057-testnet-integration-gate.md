# 057 Testnet Integration Gate

The final 057E gate runs one isolated Docker Compose project containing one
coordinator and three independent libp2p storage-node processes. The test
allocates temporary localhost ports and named volumes, so it does not use or
disturb the existing 4190 testnet.

## Lifecycle

The scenario performs:

1. encrypted upload of a file larger than 4 MiB using fixed 4 MiB plaintext
   chunks;
2. replication of every chunk to all three nodes;
3. exact download and integrity verification;
4. abrupt storage-node container termination;
5. download from surviving replicas;
6. explicit repair failure while RF=3 has no spare target;
7. restart of the same node with its durable identity and piece volume;
8. verification of the original 3/3 manifest and download;
9. coordinator stop/restart using its durable registry volume;
10. fail-closed fresh discovery during the coordinator outage;
11. node re-registration and readiness recovery;
12. post-restart encrypted placement and final exact download.

Run it with:

```sh
OPENSTORE_RUN_DOCKER_TESTNET=1 \
npx vitest run tests/integration/milestone-057e.test.ts --reporter=dot
```

The test always executes `docker compose down -v` for its temporary project.

## Security and authority invariants

Encryption occurs before transport; storage nodes receive opaque encrypted
pieces and never receive the plaintext or DEK. The test checks captured
container logs for plaintext markers, DEK bytes, and the coordinator token.
Manifest replica IDs must be unique and every chunk must have exactly three
replicas.

Plaintext chunks remain fixed at 4 MiB. The storage runtime accepts up to 8 MiB
opaque pieces to accommodate AES-GCM metadata, the JSON encrypted-piece
envelope, and transport framing. This does not weaken encryption or alter
plaintext chunking.

The coordinator remains authoritative. No automatic authority promotion,
election, failover, DHT authority, or blockchain authority is introduced.
Fresh coordinator-dependent discovery and placement fail closed while it is
unavailable. With RF=3 on exactly three nodes, there is no spare replacement
target during a node outage; repair therefore reports an explicit failure
instead of fake success.

Observability is bounded and sanitized by the existing metrics, events,
conditions, and diagnostics implementations.
