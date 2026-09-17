# Milestone 053M: Split-Brain Exclusion & Authority Fencing

053M adds an explicit ownership boundary on top of 053I–053L. It does not
implement election, quorum, consensus, leases, automatic failover, DHT
authority, or client failover.

## Single-owner invariant

`AuthorityOwnershipService` persists one ownership record. At a given issuer
authority epoch, an owner instance and ownership token are accepted at most
once. A different owner at the same epoch is a hard conflict; no timestamp,
revision, uptime, reachability, heartbeat, DHT result, lexical ordering, or
random choice selects a winner.

Higher epochs are accepted only through a separately issued, trusted grant and
validated ownership token. Epochs are issuer-owned and cannot be created or
incremented locally.

## Ownership token

The token binds the authority epoch, owner instance, grant ID, issuer identity,
state revision/digest, issuance time, and unique token ID. It is signed with
the existing Ed25519 primitives. Validation checks issuer trust and identity,
signature, candidate identity, fresh local state, revocation, epoch ordering,
and fencing/replay state.

## Lifecycle and fencing

The explicit lifecycle is:

```text
non-authoritative -> authoritative -> released
                                  -> fenced
```

`establishOwnership()` is idempotent for the exact same owner/token and
rejects a second owner at the same epoch. `releaseOwnership()` and
`fenceOwner()` persist a non-authoritative terminal transition. A fenced token
cannot be reused. No other coordinator is promoted after release or fencing.

## Persistence and recovery

Ownership records use restrictive temporary files, fsync, atomic rename, and
parent-directory fsync. Corrupt existing state fails closed and cannot silently
create authority. Restart restores valid ownership; restart after release or
fencing remains non-authoritative.

## Split-brain cases

Two candidates receiving one grant still require ownership establishment
against the same durable ownership boundary; only one owner is accepted.
Different grants at one epoch conflict. A newer snapshot, DHT observation,
network partition, heartbeat, or reachability signal never establishes
authority. During ambiguity, new authority is rejected.

The 053K control plane exposes explicit ownership establishment, release,
fencing, and sanitized ownership inspection. No unauthenticated endpoint or
force-promote shortcut exists.

Future consensus or external coordination may implement the same boundary, but
must define epoch ownership, shared conflict resolution, fencing guarantees,
revocation distribution, and crash recovery before automation is introduced.
