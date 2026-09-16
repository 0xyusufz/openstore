# OpenStore Agent Context

## 1. Vision and MVP scope

OpenStore is an open-source decentralized encrypted storage network. The MVP
chunks files, encrypts them client-side, stores opaque encrypted pieces on
replicated storage nodes, and verifies integrity during download. Providers
share an explicitly allocated, isolated local directory and may drain/release
it without silently deleting user data. Identity uses Ed25519, OpenStore
Recovery Phrase v1, and an encrypted local keystore. Blockchain, payments,
credits, incentives, erasure coding, NAT traversal, and consensus are out of
scope.

## 2. Current architecture

- `packages/crypto`: AES-256-GCM chunk encryption/decryption.
- `packages/chunking`: chunking and ordered reassembly.
- `packages/manifest`: encrypted-piece encoding, content hashes, manifests,
  and local manifest persistence.
- `packages/identity`, `packages/auth`: Ed25519 identity, recovery, keystore,
  and authenticated HTTP request signing.
- `packages/registry`: node records, capacity, reliability, persistence,
  placement metadata, and the trusted cross-process coordinator protocol.
- `packages/p2p`: transport-neutral contracts, libp2p Noise/TCP/mplex piece
  protocol, identity binding, static discovery, and Kademlia/DHT discovery.
- `apps/client`: upload/download/delete pipelines, endpoint selection, retry,
  integrity fallback, mixed HTTP/libp2p transport, and coordinator adapter.
- `apps/storage-node`: HTTP provider runtime plus standalone libp2p runtime/CLI.
- `apps/registry`: standalone coordinator CLI.
- `apps/web`: live dashboard/backend/provider lifecycle and HTTP node runtime.

Important entry points:

```text
npm run storage-node -- ...   apps/storage-node/libp2p-cli.ts
npm run registry -- ...       apps/registry/coordinator-cli.ts
npm run openstore -- ...      apps/client/cli.ts
npm run web                   apps/web/server.ts (builds first)
```

## 3. Security and cryptography rules

- File encryption is mandatory and client-side. Storage nodes receive only
  opaque encrypted piece bytes; they never receive plaintext or file keys.
- Pieces are content-addressed and verified by piece hash, envelope decoding,
  AES-GCM authentication, plaintext hash, and plaintext size.
- Ed25519 private keys, recovery phrases, passwords, seeds, DEKs, and
  coordinator tokens must never enter logs, descriptors, registry records,
  HTTP/P2P messages, or command-line arguments where an environment variable
  is supported.
- Keystores are encrypted with scrypt-derived AES-256-GCM keys and restrictive
  permissions.
- A libp2p PeerId is deterministically bound to the OpenStore Ed25519 public
  key. Discovered descriptors must pass PeerId, identity-binding, public-key,
  and multiaddr validation.
- Noise transport security remains enabled for libp2p.
- Coordinator infrastructure is trusted, but all coordinator responses are
  treated as untrusted client input and validated strictly.

## 4. Responsibilities

**Client:** chunk/encrypt files, select eligible nodes, replicate pieces,
retry transient failures, preserve explicit partial failures, verify every
downloaded replica, fall back across replicas, and delete all known replicas.

**HTTP storage node/provider:** isolate provider storage, enforce allocation
and piece quotas, authenticate requests, support draining, persist opaque
pieces, and keep existing pieces readable while draining.

**Standalone libp2p storage node:** load an encrypted identity, derive the
bound libp2p identity, expose opaque piece store/get/delete/health over the
libp2p protocol, persist pieces, advertise public metadata, heartbeat, and
gracefully unregister/shut down.

**Registry/coordinator:** maintain node records, capacity, availability,
reliability, expiry, and authenticated signed registration/heartbeat/
unregister. It is trusted coordination, not distributed consensus.

**P2P/discovery:** provide transport-neutral peer descriptors, static and DHT
discovery, validated public records, connection reconciliation, and libp2p
piece transport. It must not be coupled to client encryption/storage logic.

## 5. Important contracts

- `StorageNodeEndpoint`: `id`, `baseUrl`, optional `transport`, capacity,
  capabilities, reliability scores, and for libp2p `multiaddr`,
  `identityBinding`, and public identity.
- `P2PTransport`: `storePiece`, `getPiece`, `deletePiece`, and `health`.
  `MixedStorageTransport` routes by explicit `http(s):` versus `libp2p:`.
- Coordinator API:
    - `GET /v1/health`
    - `GET /v1/nodes`
    - `POST /v1/register`
    - `POST /v1/heartbeat`
    - `POST /v1/unregister`
  Bearer authentication is optional/configurable; node registration envelopes
  are signed with the node's OpenStore identity.
- A manifest stores piece IDs, chunk metadata, and replica node IDs. The
  encryption key is returned to the caller and is not stored in the manifest.
- `uploadBuffer`, `downloadBuffer`, and `deleteFile` accept explicit endpoint
  arrays and can resolve coordinator endpoints when that array is empty.

## 6. Completed milestones 001-043

- **001:** Added cryptographic foundation and AES-256-GCM primitives.
- **002:** Added chunking and ordered chunk reassembly.
- **003:** Added the basic HTTP storage-node runtime and piece operations.
- **004:** Added the client multi-node piece store/get pipeline.
- **005:** Added encrypted upload, manifests, opaque piece encoding, and hashes.
- **006:** Added download reconstruction with replica fallback and verification.
- **007:** Added Ed25519 identity and Recovery Phrase v1 derivation/recovery.
- **008:** Added encrypted local identity keystore persistence and hardening.
- **009:** Added signed/authenticated storage-node HTTP requests.
- **010:** Added node registry records and basic discovery.
- **011:** Integrated client discovery with registered storage nodes.
- **012:** Added capacity reporting and node health state.
- **013:** Added intelligent capacity/availability-aware node selection.
- **014:** Added persistent registry storage.
- **015:** Added provider allocation/quota enforcement.
- **016:** Added reliability and heartbeat scoring.
- **017:** Added piece integrity verification/audit support.
- **018:** Added automated storage audits and reliability updates.
- **019:** Added local manifest catalog persistence without encryption keys.
- **020:** Added client file catalog operations.
- **021:** Added remote file deletion and explicit delete reports.
- **022:** Added the client CLI foundation.
- **023:** Added the web dashboard and frontend state/view foundation.
- **024:** Added the web backend boundary and live server wiring.
- **025:** Added frontend identity/unlock/recovery flows.
- **026:** Added real web upload integration.
- **027:** Hardened real web upload behavior and boundaries.
- **028:** Added real web download, DEK vault, and live-node integration.
- **029:** Added provider lifecycle, isolated storage safety, draining, release,
  resizable quotas, persistence, and lifecycle UX.
- **030:** Added bounded retries/backoff, replica fallback, replacement/
  partial-failure handling, coalescing, and manifest consistency.
- **031:** Hardened keystore, permissions, provider identity persistence,
  storage markers, secret-buffer handling, and error exposure.
- **032:** Added transport-neutral P2P node/address/transport contracts and
  HTTP transport abstraction.
- **033:** Added real libp2p Noise/TCP/mplex opaque piece transport.
- **034:** Added static peer discovery and refresh/reconnect lifecycle.
- **035:** Extended discovery connection management and refresh behavior.
- **036:** Added local Kademlia/DHT advertisement/discovery with validation,
  deduplication, bootstrap tolerance, and clean shutdown.
- **037:** Bound OpenStore Ed25519 identity deterministically to libp2p PeerId.
- **038:** Integrated libp2p piece store/get/delete with mixed HTTP/libp2p use.
- **039:** Connected discovered peers to registry/placement metadata and
  automatic candidate insertion/removal.
- **040:** Added standalone persistent libp2p storage-node runtime/CLI.
- **041:** Added trusted cross-process coordinator registration, signed
  heartbeat/unregister, expiry, and native HTTP/HTTPS coordinator requests.
- **042:** Added client coordinator adapter, strict endpoint validation,
  refresh coalescing, last-known-good state, and coordinator-driven placement.
- **043:** Added multi-node libp2p placement/failover hardening and real
  two-node replication/failure coverage.

## 7. State after Milestone 043

Multiple coordinator-discovered libp2p nodes are converted into distinct,
validated client endpoints. `replicationFactor: 2` stores the same opaque
encrypted piece independently on two distinct eligible nodes. Download
preserves manifest replica IDs and falls back to a surviving libp2p replica
after one node stops; integrity checks still run before accepting bytes.
Delete attempts all replicas and reports unresolved failures explicitly.

Latest recorded full validation: **49 test files, 354 tests passed**;
`npm run build`, `npm run typecheck`, and `git diff --check` passed. This
status refers to the Milestone 043 implementation before the handoff file was
created; rerun validation after any further changes.

## 8. Current branch/worktree

Repository: `0xyusufz/openstore`

At handoff:

```text
branch: 0xyusufz-audit-openstore-030
tracking: origin/0xyusufz-audit-openstore-030
HEAD: a7cd071 feat: add p2p multi-node placement and failover
```

The worktree currently contains an untracked `.manual-043/` directory from
manual testing. It is not source code and should not be committed. The
handoff document itself will also appear as an untracked file until explicitly
handled by a later agent.

## 9. Git workflow

Do not commit or push unless the user explicitly requests it. Never
force-push. Do not reset, discard, or overwrite another agent's changes.
Inspect status and existing diffs before editing. Keep manual identities,
tokens, pieces, and test directories out of commits.

## 10. Manual testing workflow

1. Build with `npm run build`.
2. Start a loopback coordinator with `npm run registry -- --port 4190`;
   use `--token-env` when authentication is enabled.
3. Create encrypted keystores with `createIdentity()` and `saveIdentity()`;
   pass passwords/tokens through environment variables.
4. Start independent nodes with `npm run storage-node`, unique storage
   directories, unique listen ports, capacity, identity, coordinator URL, and
   token environment variables.
5. Inspect registration only through authenticated
   `curl http://127.0.0.1:4190/v1/nodes`; never print keystores.
6. Use the exported TypeScript APIs
   `createCoordinatorAdapter`, `uploadBuffer`, `downloadBuffer`, and
   `deleteFile` with `[]` endpoints plus `{ coordinator, replicationFactor: 2 }`
   to test coordinator placement, replication, failover, and delete.
7. Stop one node and verify download succeeds from the surviving manifest
   replica; verify delete reports the offline replica rather than hiding it.
8. Stop all processes with SIGINT/SIGTERM and remove only explicitly named
   manual-test directories after inspection.

## 11. Known limitations and unresolved items

- The coordinator is trusted infrastructure; there is no decentralized
  consensus or replacement coordinator.
- No blockchain, incentives, payments, credits, erasure coding, NAT traversal,
  public relays, or production peer discovery deployment is implemented.
- The client API has no dedicated shell command for the full
  coordinator-to-libp2p upload/download/delete E2E; use the TypeScript APIs.
- DHT discovery and coordinator placement are separate mechanisms; the
  coordinator is the cross-process placement source.
- Tests use local loopback nodes/processes and do not prove public-network
  reachability or NAT traversal.
- The web live runtime and standalone libp2p runtime are separate deployment
  paths; do not assume they share an in-memory registry across processes.
- Capacity/reliability metadata is advisory input to placement and must remain
  validated; durable distributed capacity claims are not a consensus feature.
- Any uncertainty about milestone numbering beyond source comments/history
  should be checked against commits rather than inferred.

## 12. Engineering/security invariants

- Never accept plaintext or encryption keys at storage nodes.
- Never put private keys, recovery phrases, passwords, seeds, DEKs, or bearer
  tokens in network messages, descriptors, registry records, logs, or files
  intended for discovery.
- Preserve Ed25519 identity binding and Noise authentication.
- Validate every untrusted coordinator/DHT descriptor before placement.
- Preserve piece hash, envelope, AES-GCM, plaintext hash, and size checks.
- Preserve bounded retry/backoff, replica fallback, coalescing, and explicit
  partial-failure reporting.
- A successful operation must reflect actual successful replicas; never report
  fake success.
- Draining/release must not silently delete user data.
- Preserve storage isolation, quota enforcement, permissions, and persistence.

## 13. Rules for future agents

- Preserve existing HTTP behavior and compatibility.
- Keep all storage-node bytes opaque; never send plaintext file contents.
- Never expose private keys in network messages or configuration/CLI output.
- Never silently delete data or silently downgrade a transport.
- Preserve replication, integrity verification, retry/backoff, fallback, and
  operation coalescing behavior.
- Treat coordinator, DHT, capability, capacity, address, and identity metadata
  as untrusted until strictly validated.
- Keep blockchain/economics/P2P architecture changes out of unrelated work.

## 14. Recommended next milestone direction

Based only on the current repository, the next useful direction is operational
hardening rather than adding economics or a new network layer: define a
repeatable cross-process integration harness for coordinator registration,
two-node replication, node expiry, restart/persistence, and mixed HTTP/libp2p
placement. Then address any discovered lifecycle, observability, or
coordinator durability gaps with focused tests while preserving the current
trusted-coordinator boundary. No specific next milestone number or roadmap
document was found in the source tree.

## 15. Milestone 044 status

Milestone 044 is implemented as a real cross-process integration harness in
`tests/integration/milestone-044.test.ts`. It starts a coordinator and two
standalone libp2p storage-node child processes on dynamic loopback ports,
authenticates registration and discovery, uploads with replication factor two,
verifies identical opaque piece files, downloads exactly, kills one node and
waits for coordinator expiry, downloads from the same manifest through the
surviving replica, restarts the node with the same encrypted identity and
storage directory, verifies stable PeerId and persisted data, and exercises
authenticated mixed HTTP/libp2p placement, download, and delete.

The harness uses bounded polling, temporary directories, child-process cleanup,
and environment variables for test-only secrets; it does not print secrets or
piece contents. Coordinator expiry is represented by the existing registry
record becoming unavailable rather than being physically deleted. The test
passed locally in approximately 9 seconds. No production runtime changes were
needed. The current worktree still contains pre-existing untracked
`.manual-043/` artifacts and untracked `tests/` content; do not remove or
commit them without reviewing ownership.
