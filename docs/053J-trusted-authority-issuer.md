# Milestone 053J: Trusted Authority Issuer

053J adds a minimal vendor-neutral issuer boundary for 053I authority grants.
It is an explicit control-plane primitive, not an election or failover
mechanism.

## Issuer trust and authorization

`packages/coordinator-ha/authority-issuer.ts` uses an existing Ed25519
identity and derives a durable issuer instance identity. Every issuance request
contains an authenticated caller identity and must pass both
`authenticate()` and `mayIssue()` in the injected authorization interface.
The candidate instance may never issue its own grant.

No HTTP, OAuth, DHT, reachability, heartbeat, latest-revision, or startup
authority is inferred. A future control plane can provide the authentication
and authorization adapter without changing the issuer core.

## Bootstrap and epoch ownership

The issuer does not silently initialize authority. Its persistence record must
be explicitly bootstrapped with an initial epoch through `bootstrap()`. The
epoch is issuer-owned, persisted, and must match every issuance request. It is
never derived from time, revisions, process IDs, or DHT observations.

Missing or corrupt state is unavailable and cannot be bootstrapped implicitly.
Restart reloads the issuer identity, initialization state, epoch, audits, and
revocations. A production control plane must define how a fresh issuer
bootstrap is authenticated and audited.

## Grant issuance

Issued grants contain:

- candidate instance ID;
- authority epoch;
- state revision and digest;
- caller-supplied unique grant ID;
- issuance and expiry times;
- issuer instance ID and public key;
- Ed25519 signature over the canonical 053I payload.

Inputs are validated without selecting candidate, state, epoch, or grant ID.
The issuer rejects stale/future timestamps, excessive lifetimes, wrong epochs,
malformed state digests, and duplicate grant IDs. Candidate-side 053I
validation still verifies issuer trust, signature, freshness, and local state.

## Audit and persistence

The issuer stores bounded sanitized audit records containing grant ID,
candidate, epoch, revision, digest, issuer identity, times, caller identity,
and outcome. Private keys, secrets, file contents, and raw credentials are
never persisted in the audit record. Persistence uses restrictive temporary
files, fsync, atomic rename, and parent-directory fsync.

## Revocation

Revocation is explicit and authorized. The issuer persists revoked grant IDs
and marks the corresponding audit outcome. The 053I candidate service accepts
an injected bounded revocation lookup and rejects revoked grants. This is a
validation boundary only; distributed revocation propagation is intentionally
not implemented. Unknown or ambiguous revocation state must fail closed.

## Non-goals and future control plane

053J does not implement automatic promotion, election, quorum, Raft, Paxos,
leases, fencing, coordinator failover, DHT authority, or client failover. It
does not expose a force-promote endpoint. A future control plane must provide
strong caller authentication, explicit operator intent, auditability,
revocation distribution, issuer bootstrap ceremony, and split-brain safety.
