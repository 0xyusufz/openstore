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
- **046:** Added aggregate coordinator health, safe registry node lifecycle
  events, coordinator-owned expiry scheduling, read-only node status snapshots,
  sanitized runtime lifecycle/recovery telemetry, client last-known-good
  metadata, and focused lifecycle integration coverage.

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

Milestone 046 validation: **52 test files, 362 tests passed**; `npm run build`,
`npm run typecheck`, and `git diff --check` passed.

## 8. Current branch/worktree

Repository: `0xyusufz/openstore`

Current worktree:

```text
branch: 0xyusufz-audit-openstore-030
tracking: origin/0xyusufz-audit-openstore-030
HEAD: 37b71e0 feat: harden coordinator lifecycle recovery
```

Milestone 046 changes are currently uncommitted. The worktree also contains an
untracked `.manual-043/` directory from manual testing. It is not source code
and should not be committed.

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

## 16. Milestone 045 status

Milestone 045 adds operational hardening without changing the trusted
coordinator architecture or HTTP storage behavior. Registry persistence now
reports safe load/write/degraded status and injectable lifecycle events while
retaining atomic temp-file plus rename writes and usable in-memory state when a
write fails. The coordinator exposes backward-compatible health data plus
`/v1/status`, safe lifecycle hooks, and contextual client errors classified as
transient, authentication, configuration, or protocol failures.

The standalone libp2p runtime now tracks `starting`, `registered`,
`coordinator-unreachable`, `reconnecting`, and `stopped`; it coalesces
registration work, retries with bounded exponential backoff, re-registers
after coordinator state loss, resumes heartbeats after recovery, and cancels
timers during shutdown. CLI lifecycle output is structured and sanitized.

`tests/integration/milestone-045.test.ts` starts a persisted authenticated
coordinator and two real standalone nodes, verifies replicated encrypted
storage, stops and restarts only the coordinator, confirms metadata reload and
node recovery, verifies expiry of a killed node, restarts that node with the
same identity and storage, and confirms persisted retrieval. Focused tests also
cover persistence degradation, contextual coordinator errors, and safe runtime
lifecycle events. Full validation must be rerun after later changes.

## 17. Milestone 046 status

Milestone 046 adds safe coordinator aggregate health/status fields, timestamped
registry lifecycle events, an optional coordinator-owned expiry worker, public
standalone libp2p runtime status snapshots, bounded sanitized recovery events,
and client refresh metadata while preserving last-known-good endpoints. README
and local-development documentation now describe coordinator status, expiry,
recovery, and troubleshooting.

The dedicated Milestone 046 tests cover aggregate expiry-worker behavior,
last-known-good client metadata, and safe storage-node status. Milestones 044
and 045 remain the real child-process coverage for multi-node placement,
coordinator restart, persistence, and recovery. The current validation is
**52 test files, 362 tests passed**, with build, typecheck, and diff-check
passing. No commit or push has been made.

## 18. Milestone 047 status

Milestone 047 adds resilient, coalesced discovery refreshes (including an
explicit `refreshNow()` path), verified libp2p peer connection lifecycle
events/state, bounded reconnect scheduling, strict endpoint
transport/capability validation, and a reusable manifest replica endpoint
resolver. New placement requires a fresh coordinator refresh; existing
manifest downloads and deletes use all known manifest replica metadata during
coordinator outages and preserve unavailable-replica failures. No repair or
re-replication was added. Coordinator adapters expose available and all-known
snapshots separately; discovery removes stale peers and cancels pending
reconnects during refresh and shutdown. Validation passed with **53 test files,
368 tests**; Milestone 047 now includes a bounded authenticated child-process
scenario covering two standalone nodes, abrupt node loss, surviving-manifest
download, outage deletion failure, and same-identity restart/re-registration.
Reconnect attempts are bounded by the configurable
`maxReconnectAttempts` (default 5) and emit sanitized `reconnect.exhausted`
events. No commit or push has been made.

## 19. Milestone 048B status

Milestone 048B adds explicit client-side replica repair in
`apps/client/repair.ts`. Repair is never triggered implicitly by upload,
download, delete, or audit operations. A caller supplies the manifest file ID
and confirmed-lost node ID together with the local `ManifestStore` and
coordinator adapter.

Repair uses bounded fresh coordinator observations. One request failure,
heartbeat miss, audit failure, or failed download is not sufficient. The lost
node must remain absent from consecutive fresh available snapshots through the
configured bounded observation/grace window. If it reappears, repair aborts
conservatively. The current coordinator model does not expose authoritative
draining state, so repair does not invent draining semantics or treat
ambiguous lifecycle state as permanent loss.

Source resolution is restricted to surviving node IDs already recorded in the
manifest. The client copies exact opaque encrypted piece bytes, verifies their
SHA-256 piece ID, and never decrypts, re-encrypts, accesses the DEK, or sends
plaintext to a node. Replacement targets come only from a successful fresh
coordinator refresh and must be distinct, available, piece-store capable,
capacity-valid, transport-valid, and identity-valid. Existing exact target
bytes are idempotent success; mismatched bytes fail closed.

Manifest changes use only the Milestone 048A revision/CAS API. A successful
repair changes an affected replica set atomically, such as `A+B` to `A+C`;
the manifest never persists an intermediate reduced-replica state. Bounded
CAS reconciliation handles concurrent updates without blind last-write-wins.
Same-file/piece repair requests coalesce in process. Repair is stateless across
client restarts; no persistent journal or automatic garbage collector was
added. A verified target write may remain unreferenced if a later CAS fails,
which is safe but requires future explicit orphan cleanup.

Focused repair coverage is in `apps/client/repair.test.ts`. Real
cross-process coverage is in `tests/integration/milestone-048b.test.ts` and
starts an authenticated coordinator plus three independent libp2p nodes,
terminates one replica, waits for expiry/observation, repairs to the third
node, verifies identical opaque bytes, checks the atomic manifest result, and
downloads the original plaintext.

Milestone 048B validation: **55 test files, 384 tests passed**;
`npm run build`, `npm run typecheck`, and `git diff --check` passed. No
commit or push has been made. The next recommended milestone is explicit
orphan-piece cleanup/repair scheduling only after its ownership and safety
semantics are designed; blockchain, economics, consensus, public networking,
and encryption changes remain out of scope.
`npm run build`, `npm run typecheck`, and `git diff --check` also pass. Changes
remain uncommitted and the pre-existing `.manual-043/` artifacts are preserved.

## 20. Milestone 049A status

Milestone 049A adds the explicit opt-in `RepairScheduler` in
`apps/client/repair-scheduler.ts`. The scheduler scans persisted manifests
once per cycle, obtains one fresh coordinator snapshot, identifies unavailable
manifest-listed replicas, coalesces candidates by file/chunk/piece/lost-node,
and invokes the existing `repairManifestReplica()` implementation. It does
not duplicate source verification, opaque-piece copying, target selection, or
manifest CAS logic.

Scheduler state is in memory only and has `stopped`, `running`, and `paused`
states. Per-candidate lifecycle events cover queueing, observation, confirmed
loss, repair, completion, failure, cancellation, and node recovery. Events and
status snapshots contain only safe identifiers, classifications, counters,
timestamps, and bounded retry metadata; piece bytes, plaintext, keys,
credentials, and signatures are never included.

Global repair concurrency defaults to two and per-file concurrency defaults to
one. Queue size, scheduler retry rounds, exponential backoff, and cooldown
are bounded and configurable. Coordinator outages do not confirm loss or
select targets from stale metadata. Restarting the scheduler rescans
manifests and starts fresh observations; no repair journal was added.

049A never deletes storage pieces. In particular, a successful target write
followed by a failed or conflicting manifest CAS leaves the opaque piece
untouched. Automatic orphan cleanup/garbage collection is explicitly deferred
to 049B because current storage nodes lack safe ownership/provenance metadata.
Coordinator draining semantics were not invented or expanded.

Focused unit coverage is in `apps/client/repair-scheduler.test.ts`. Real
child-process coverage is in `tests/integration/milestone-049a.test.ts`; it
verifies restart-before-confirmation, confirmed loss, repair from A to C,
identical ciphertext, manifest replacement, and plaintext download.

Milestone 049A validation: **57 test files, 391 tests passed**;
`npm run build`, `npm run typecheck`, and `git diff --check` passed. No commit
or push has been made.

## 21. Milestone 049B provenance foundation

Milestone 049B adds a durable provenance foundation without enabling automatic
orphan cleanup. `packages/provenance/index.ts` defines opaque claim and
operation identifiers, upload/repair claim metadata, monotonic claim states
(`pending`, `referenced`, `released`), validation, and safe transition rules.
`apps/storage-node/provenance-store.ts` persists per-piece claim metadata below
the node's `.provenance` directory using restrictive `0600` files, temporary
write plus atomic rename, per-piece serialization, idempotent claim creation,
restart recovery, and cross-client release checks.

Authenticated versioned HTTP endpoints under `/v2/pieces` and the separate
`/openstore/provenance/1.0.0` libp2p protocol expose claim creation, claimed
opaque-piece association, reference/release/reconcile transitions, and
conditional `delete-if-unclaimed`. Existing `/pieces` and
`/openstore/piece/1.0.0` behavior remains unchanged. Client helpers in
`apps/client/provenance.ts` use an opaque namespace derived from the
authenticated Ed25519 public key and never transmit plaintext, DEKs, private
keys, recovery phrases, or tokens as provenance metadata.

Conditional deletion is a primitive only: no scanner, lease-expiry deletion,
automatic garbage collection, or ordinary DELETE behavior change was added.
Identity-enabled upload and repair paths now use the claim lifecycle and a
durable client operation store: claim creation precedes writes, exact opaque
bytes are read back and verified, manifest CAS precedes reference promotion,
and uncertain operations retain their claims. Legacy callers without
provenance identity/options remain compatible. On restart, operation records
can be reconciled against the authoritative local manifest before promoting a
verified claim to referenced.

Focused provenance coverage is in `packages/provenance/index.test.ts`,
`apps/storage-node/provenance-store.test.ts`, and
`apps/client/provenance.test.ts`. Real child-process coverage is in
`tests/integration/milestone-049b.test.ts`; it verifies claim and opaque-piece
retention across node restart, durable operation reload, reconciliation,
referenced-state persistence, cross-client release protection, and refusal to
conditionally delete referenced data. Validation passed with **61 test files
and 398 tests**, plus `npm run build`, `npm run typecheck`, and
`git diff --check`. Automatic orphan cleanup remains deferred to 049C.
## 22. Milestone 049C safe orphan cleanup

Milestone 049C adds opt-in, node-local orphan scanning. Version 2 provenance
envelopes record the opaque piece ID, managed timestamp, monotonic cleanup
deadline, and durable claims. Missing, corrupt, partial, unsupported, or
legacy metadata is fail-closed and permanently retained. A piece is eligible
only when every claim is released and the configured grace period has elapsed
(24 hours by default; shorter periods are test-only configuration).

`apps/storage-node/orphan-scanner.ts` performs bounded, cancellable,
non-overlapping scans with a 15-minute default interval, batch size 100,
maximum 10 deletions per run, and sanitized lifecycle events. Cleanup uses
the provenance store's same per-piece lock through the conditional delete,
deletes only exact regular files directly inside managed storage, and removes
metadata only after confirmed deletion. Ordinary DELETE, manifests,
coordinator ownership, repair, encryption, and piece protocols are unchanged.
HTTP and standalone libp2p runtimes start and stop the scanner only when
`orphanCleanup.enabled` is explicitly set.

Coverage includes provenance envelope validation, grace and claim retention,
scanner bounds/cancellation, legacy protection, and child-process persistence
in `apps/storage-node/orphan-scanner.test.ts` and
`tests/integration/milestone-049c.test.ts`. Automatic repair and broader
provenance reconciliation remain outside 049C; future 049D work must not
interpret missing metadata as orphan evidence.

Changes remain uncommitted and unpushed.

## 23. File deletion and provenance release follow-up

Intentional client file deletion now associates identity-enabled upload and
repair operation records with the opaque manifest file ID. `deleteFile`
creates a durable deletion intent before issuing ordinary authenticated
piece DELETE requests. Only after a node confirms deletion or absence does
the client mark the exact operation deleted, request release, and release
that operation's exact claim using the existing authenticated owner check.
Claims are never selected by piece alone, and claims belonging to other
clients or other files remain untouched.

Release failures do not trigger another destructive delete and are surfaced
in `provenanceReleaseFailures`; the operation remains in
`release-requested`. `reconcileDeletedProvenanceOperations` safely retries
only those post-delete releases after restart. A crash before deletion
leaves a pending intent and protected claim; a crash after deletion leaves
the claim protected until the operation is retried or reconciled. Legacy
deletions without provenance operation records retain their historical
behavior. No FileManifest fields, ordinary DELETE semantics, coordinator
ownership, or 049C scanner rules were changed.

Focused coverage is in `apps/client/delete-provenance.test.ts`; the full
suite passed with **64 test files and 403 tests**, alongside successful
build, typecheck, and `git diff --check`. Changes remain uncommitted and
unpushed.

## 24. Milestone 050A Docker testnet packaging

050A adds packaging only under `deploy/testnet/`. The Compose topology
contains one authenticated coordinator and three independent standalone
libp2p storage-node services on an isolated bridge network. The coordinator
persists its registry state; every node has separate named identity and
piece/provenance volumes. Nodes advertise container-reachable
`/dns4/node-N/tcp/410N` multiaddrs while host-published ports remain loopback
only.

`deploy/testnet/Dockerfile` builds the existing TypeScript runtime into a
minimal Node image. Entrypoints inject coordinator tokens and node keystore
passwords only through environment variables. A node generates an encrypted
identity keystore on first start only when its persistent identity path is
absent, using the existing identity format and restrictive permissions.
Secrets and `.env.testnet` are excluded from the Docker build context.

050A does not add a client daemon, operator orchestration wrapper, Docker
failure smoke test, scanner CLI flags, or protocol changes. Those remain
planned for 050B/050C. Packaging validation passed, including **65 test files
and 405 tests**, `npm run build`, `npm run typecheck`, `git diff --check`, and
`docker compose config` using the placeholder environment example. Changes
remain uncommitted and unpushed.

## 25. Milestone 050B operational persistence

050B adds `deploy/testnet/testnet.sh`, a small secret-safe lifecycle helper
for `start`, `stop`, `restart`, `status`, `logs`, and explicitly confirmed
`reset --yes`. It reads `.env.testnet` through an environment-file path,
never embeds coordinator tokens or node passwords, preserves named volumes
for ordinary stop/restart, and does not restart after a destructive reset.
The Compose services use `restart: unless-stopped` while retaining localhost
host bindings and container-reachable libp2p advertised addresses.

The 050A storage entrypoint already performs the required persistence
behavior: it generates an encrypted identity keystore only when the mounted
identity path is absent, then always reuses that path. Coordinator registry
state remains mounted at the persistent registry volume. Focused static
coverage is in `tests/integration/milestone-050b.test.ts`; no Docker
containers are started by tests. Full validation passed with **66 test files
and 407 tests**, `npm run build`, `npm run typecheck`, shell syntax checks,
`git diff --check`, and `docker compose config`. The full multi-node client
and failure smoke test remains deferred to 050C. Changes remain uncommitted
and unpushed.

## 26. Milestone 052A coordinator failure-model foundation

052A documents the current coordinator authority boundaries and adds the
vendor-neutral `packages/discovery-state` capability model. The coordinator
remains authoritative for signed node registration, heartbeats, expiry and
pruning, placement candidates, capacity visibility, and fresh repair
candidate discovery. Registry persistence is atomic and fsync-backed, but
there is still one coordinator authority and no replicated or consensus layer.

The client coordinator adapter retains a last-known-good endpoint snapshot.
Fresh coordinator information is required for new upload placement and repair
replacement selection. Existing-manifest download and delete may continue
against known recorded replicas during a coordinator outage, but they never
invent replacement replicas. Node startup can initialize local identity and
storage without coordinator availability; registration and heartbeat reconnect
later according to the existing lifecycle. DHT/static discovery is separate
from coordinator-authoritative placement.

`packages/discovery-state` classifies bounded aggregate observations as
`fresh`, `cached`, `stale`, or `unavailable`. Cached information can support
existing-replica reads/deletes; only fresh information can authorize new
placement or repair. It stores no identifiers, secrets, per-piece state, or
durable history.

The DHT audit found validated versioned peer descriptors with identity
bindings, bounded bootstrap/query timeouts, and disappearance reconciliation,
but no application-level record expiry timestamp, revocation record, or
durable disappearance authority. Kademlia record lifetime and stale-record
handling remain future work.

Recommended 052B scope: implement explicit coordinator adapter state
transitions, bounded freshness leases, stale transitions, reconnect backoff,
and operation-specific policy enforcement while preserving current fail-closed
placement semantics. Do not add Raft, etcd, leader election, quorum,
distributed locks, external databases, DHT consensus, or unsafe automatic
failover.

052B is now implemented additively. `packages/discovery-state` remains the
single freshness-policy model, while `apps/client/coordinator.ts` owns the
bounded runtime observation state exposed as `discovery` and metadata. The
default freshness lease is 30 seconds and the stale retention window is five
minutes; both are validated and configurable. Failed refreshes never erase the
last-known-good endpoint snapshot. The adapter reports fresh, cached, stale,
or unavailable state without exposing endpoints or identifiers in diagnostics.

Coordinator-driven upload placement and repair replacement now fail closed
when fresh information is unavailable, with contextual coordinator discovery
errors/classifications. Existing-manifest download and delete retain their
known-replica behavior during outages and never invent replacements. Refresh
coalescing and existing bounded retry/backoff behavior remain unchanged.

Recommended 052C scope: use these explicit state transitions in operator
conditions/diagnostics and add lifecycle reconnect state where needed; keep
HA/consensus, durable discovery leases, and DHT revocation/expiry as separate
future design work.

052C adds bounded coordinator discovery observability. The client adapter now
accepts optional existing `MetricsRegistry` and `EventStore` instances and
reports `fresh`, `cached`, `stale`, `unavailable`, and transient
`reconnecting` state. It records only aggregate endpoint count and bounded
observation age, increments low-cardinality refresh outcome/state metrics, and
emits one sanitized event per state transition (not per diagnostic poll).
Freshness policy and operation behavior are unchanged: new placement and
repair replacement still require fresh information; existing manifest
download/delete may use known replicas.

The condition evaluator now exposes deterministic coordinator discovery
conditions for all five states. Coordinator status, health, and conditions
responses accept an additive safe discovery diagnostic containing only state,
age, endpoint count, and fresh-placement availability. Readiness semantics and
authentication are unchanged. These diagnostics/events/metrics are
process-local and reset on restart.

Recommended 052D scope: reconcile client discovery state with coordinator and
storage-node lifecycle diagnostics, add bounded reconnect outcome guidance,
and define a future authenticated monitoring-consumer contract without
introducing durable telemetry or coordinator HA.

052D hardened DHT discovery without changing its authority boundary. DHT
descriptors are published in a versioned record envelope with a bounded
`publishedAt` timestamp. Records more than 30 seconds future-dated or five
minutes old are rejected as invalid/stale; a query never renews record age.
Fresh, stale, invalid, and unavailable are explicit trust outcomes, while
stale/invalid records are ignored and counted through bounded
`dht_record_rejections_total{reason=stale|invalid}` metrics.

Existing identity validation remains mandatory: the OpenStore Ed25519 public
key must derive the PeerId, identity binding must match, and a `/p2p/`
multiaddr identity must match the descriptor. Private material is rejected.
Static discovery behavior, bootstrap dialing, one-second DHT timeouts, and
bounded refresh scheduling remain unchanged. Coordinator data remains the only
placement authority; no DHT peer becomes placement eligible from discovery
alone.

Recommended 052E scope: define authenticated DHT revocation/expiry authority
and reconciliation with coordinator observations only if a separate trust
authority is established. Do not infer revocation from disappearance alone.

052E now makes the authority boundary explicit in `packages/authority`.
`classifyAuthority` returns immutable, aggregate-only decisions:
`coordinator-authoritative`, `dht-discovered`, `stale`, `invalid`, or
`unavailable`. Placement is authorized only for an explicitly
coordinator-authoritative fresh observation with usable endpoints. DHT
observations remain non-authoritative even when fresh and can only support
existing peer discovery.

`reconcileAuthority` deterministically gives a fresh authoritative coordinator
observation the placement win. Stale/invalid DHT data cannot override it;
disagreement produces no automatic failover. Both DHT disappearance and
coordinator disappearance explicitly remain non-revocation events. The model
is immutable and stores no identifiers, URLs, secrets, or per-peer history.

Future revocation remains architecture work: it needs an independently
authorized signer, an authenticated peer-identity binding, replay/freshness
rules, bounded verification, and defined coordinator-outage behavior. No
revocation or new trust service was introduced.

Milestone 053A adds `packages/coordinator-ha`, a small pure foundation for a
future coordinator HA implementation. It defines a vendor-neutral
`CoordinatorService` boundary for registration, heartbeat, unregister,
discovery, persistence status, health, and bounded state snapshots. It does
not replace the current registry or route runtime traffic through a new
adapter.

The state model classifies authoritative persistent registry state separately
from derived/process-local state and client caches. It provides immutable
versioned metadata with bounded instance identity, monotonic local revision,
validated observation timestamp, and `known`/`stale`/`unknown` state. Local
revisions are explicitly not distributed conflict resolution and cannot
justify last-writer-wins or automatic promotion. Non-authoritative or
ambiguous snapshots cannot authorize placement.

The 053A architecture document defines complete authenticated bootstrap
requirements for future replicas, persistence verification, outage semantics,
and split-brain safety. A reachable standby is not authoritative merely
because the primary is unavailable. Ambiguity fails closed for new placement
and repair, while existing-manifest download/delete retain 052B behavior.
Coordinator instance identity persistence, authority proof, write ordering,
and client routing remain unresolved 053B design decisions.

Milestone 053B adds the authenticated bootstrap foundation in
`packages/coordinator-ha`. A coordinator instance identity is deterministic
from a durable public key and has a canonical persist/reload representation;
the private signing key is never part of a snapshot or proof. Bounded
authoritative snapshots include node registrations, identity bindings,
heartbeat/availability, capacity, transport metadata, and reliability
counters, while metrics/events/conditions/replay caches remain derived.

Canonical snapshot serialization and SHA-256 digests are signed with an
injected Ed25519 key by a versioned authority proof. Verification binds the
instance, revision, digest, authoritative classification, and bounded issued
timestamp. `CoordinatorBootstrapMachine` accepts only complete, trusted,
cryptographically valid snapshots and otherwise remains rejected, stale, or
unavailable. It never promotes a standby because a coordinator is unreachable
and does not treat a higher untrusted revision as authoritative.

053B does not add a transport endpoint, registry replication, consensus,
leader election, fencing, automatic failover, revocation, or client changes.
The proof demonstrates integrity and signer identity, not exclusive
single-coordinator authority; split-brain prevention and write ordering remain
future HA work. See `docs/053B-coordinator-replica-bootstrap.md`.

Milestone 053C adds `CoordinatorReplicaStateTransfer`,
`createCoordinatorSnapshotExporter`, and `CoordinatorReplicaImporter` to the
coordinator HA package. The exporter provides a bounded versioned snapshot
and 053B authority proof. The importer distinguishes transport
authentication, snapshot integrity, signer identity, coordinator authority,
and replica authority; even accepted state is always diagnosed as
`non-authoritative`.

Replica installation validates the trusted source identity, canonical digest,
proof, timestamps, node records, size/count bounds, and revision tuple before
replacement. Same revision and digest is idempotent; same revision with a
different digest, lower revisions, unknown sources, and conflicting instance
identities are rejected. Higher revisions require an explicitly trusted
source and valid proof. Persistence uses restrictive temporary files,
flush/rename semantics, schema validation, and fail-closed reload behavior.
Corrupt or missing state, cancellation, malformed input, and persistence
failure cannot grant authority or partially replace accepted state.

053C does not add a coordinator HTTP endpoint, consensus, election,
promotion, fencing, replication ordering, client failover, or DHT authority.
The current coordinator remains the sole runtime authority; see
`docs/053C-coordinator-state-transfer.md`.

Milestone 053D adds deterministic coordinator replica ordering and conflict
safety. Accepted observations are bound to
`coordinatorInstanceId + revision + snapshotDigest`; duplicates are
idempotent, lower revisions are stale, same-revision digest changes are hard
conflicts, and different or unknown instances cannot replace accepted state.
One explicitly configured trusted source is required and trust never migrates
automatically.

Replica lifecycle diagnostics now distinguish `synchronized`, `stale`,
`conflicted`, `rejected`, and `unavailable`. Synchronized means validated
state was accepted, not that the replica is authoritative. Conflicted state
retains the previous accepted snapshot, reports a sanitized typed reason, and
cannot serve as an authority source. Import metadata records last successful
and rejected observations without treating local observations as global
ordering.

Persistence recovery validates schema, digest/proof binding, trusted source,
and freshness; failed writes preserve the previous accepted state. No
consensus, election, promotion, fencing, LWW resolution, client failover, or
automatic authority migration was introduced. See
`docs/053D-coordinator-write-ordering.md`.
