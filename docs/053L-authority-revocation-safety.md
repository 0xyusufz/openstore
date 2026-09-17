# Milestone 053L: Durable Authority Revocation & Safety Boundary

053L hardens the explicit 053J/053K authority path with durable revocation
records. It does not add automatic promotion, failover, election, quorum,
leases, fencing, DHT authority, or client failover.

## Revocation record and persistence

The issuer persists versioned records containing:

- record ID (`revoke-<grantId>`);
- grant ID;
- candidate instance ID;
- authority epoch;
- issuer instance ID;
- revocation timestamp;
- sanitized reason;
- authenticated caller identity.

Records are stored with issuer state using restrictive temp-file writes,
file fsync, atomic rename, and parent-directory fsync. The bounded store
refuses new records when capacity is exhausted rather than evicting old
revocation evidence. Corrupt existing state is unavailable and cannot be
silently recreated or bootstrapped.

Repeated revocation with identical metadata is idempotent. A different reason
or caller for an already revoked grant is a conflict. Revocation record IDs
and grant IDs cannot be replayed or reused.

## Candidate enforcement

Before acceptance, the candidate validates the grant signature, issuer,
candidate identity, freshness, epoch, state revision/digest, and replay
conditions, then checks revocation. A lookup returning the grant ID rejects.
An unavailable, throwing, malformed, or ambiguous lookup fails closed.
Revocation therefore cannot be bypassed by presenting the same epoch, newer
state revision, a restart, DHT observations, or reachability.

## Current authority and control plane

The explicit 053K revoke operation persists issuer revocation and explicitly
demotes the current candidate. No other coordinator is selected or promoted.
Inspection exposes sanitized issuer, candidate, epoch, grant, audit, and
revocation metadata. No private keys, secrets, credentials, or file contents
are persisted or exposed.

Revocation is not automatically propagated across a distributed system. A
future authenticated control plane must deliver revocation status or an
equivalent signed/replay-protected evidence source; ambiguity remains
non-authoritative.

## Restart and non-goals

Issuer restart reloads revocation records and continues rejecting revoked
grants. Candidate restart preserves its persisted revoked/non-authoritative
state. Corrupt issuer or candidate state fails closed. Authority epochs are
never created locally. Existing coordinator, client outage, placement, repair,
and DHT discovery semantics remain unchanged.
