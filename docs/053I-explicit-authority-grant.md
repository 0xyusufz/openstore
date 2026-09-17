# Milestone 053I: Explicit Authority Grant

053I adds the first concrete authority transition, but only through an
explicitly issued and authenticated grant. There is no automatic promotion,
election, failover, lease, quorum, fencing, or DHT authority.

## Trust model and grant format

`packages/coordinator-ha/authority-grant.ts` implements a grant service over
the 053H authority contract. A signed grant contains:

- candidate coordinator instance ID;
- monotonically issued authority epoch;
- validated state revision and SHA-256 state digest;
- unique grant ID;
- bounded issuance and expiry timestamps;
- issuer instance ID and Ed25519 public key;
- Ed25519 signature over the canonical grant payload.

The issuer public key must be configured as trusted. The candidate must match
the local durable coordinator instance identity. The grant is accepted only
when its signature, issuer, freshness, epoch, revision, digest, and local
state match all validate. Identity proof alone is not authority proof.

## Lifecycle

The service starts `non-authoritative` unless valid durable authority state is
loaded. `acceptGrant()` is the only promotion path and must be called
explicitly with a signed grant. The transition is:

`non-authoritative -> authoritative`

The exact same accepted grant is idempotent. A different grant cannot silently
replace an authoritative grant. `revoke()`/`demote()` persist a `revoked`
state and do not automatically promote another instance. Missing or corrupt
state starts non-authoritative.

`requestPromotion()` intentionally rejects: grants must be issued by a trusted
external operator/control plane, not generated locally.

## Persistence and replay safety

The persisted versioned record contains the local instance ID, authority
state, authority epoch, accepted grant ID, accepted revision/digest, and
issuance/acceptance metadata. Writes use a restrictive temporary file,
`fsync`, atomic same-directory rename, and restrictive permissions.

Epochs never increase locally. Epochs lower than the persisted epoch are
rejected; a grant at the current epoch cannot reuse a consumed grant ID.
State revision/digest must exactly match fresh validated local state. Grants
outside the bounded freshness window or past expiry are rejected.

## Split-brain boundary

Reachability, heartbeats, latest revision, latest timestamp, DHT records,
startup, and absence of another coordinator are not authorization. Ambiguous
issuer, identity, state, epoch, replay, persistence, or split-brain conditions
fail closed. Existing 052B behavior remains unchanged: known-manifest
download/delete may use known replicas during outage, while new placement and
repair require current coordinator authority.

## API and future control plane

The service exposes inspection, explicit grant acceptance, validation,
revoke/demote, and the contract-only controller methods. No unauthenticated
HTTP endpoint or force-promote shortcut is added. A future control plane must
authenticate the operator, authorize the issuer, bind the grant to an
auditable intent, protect against replay, and record the action durably.

Future quorum/consensus mechanisms may implement the same contract, but must
also define authority epoch ownership, split-brain exclusion, revocation,
rollback recovery, and durable audit semantics.
