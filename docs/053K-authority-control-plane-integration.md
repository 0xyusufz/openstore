# Milestone 053K: Authority Control-Plane Integration Boundary

053K provides a vendor-neutral in-process control-plane boundary joining the
053J trusted issuer and 053I candidate grant service. It does not change
startup behavior: the current coordinator remains authoritative by default,
replicas remain non-authoritative, and no control-plane method is called
automatically.

## Explicit lifecycle

The control-plane API has separate operations:

1. `requestGrant` / `issueGrant` — authenticated caller and authorizer request
   an issuer-signed grant.
2. `deliverGrant` — bind the signed grant to the expected issuer and candidate.
3. `acceptGrant` — explicitly invoke the candidate's complete 053I validation.
4. `inspect` — expose sanitized state, epoch, grant, audit, and transition data.
5. `revokeGrant` — explicitly revoke at the issuer and demote the candidate.

The only transition to authority is:

```text
authenticated caller
  -> authorized issuer
  -> signed explicit grant
  -> identity-bound delivery
  -> candidate validation
  -> explicit acceptGrant()
  -> authoritative
```

Candidate-side validation still requires trusted issuer identity, valid
signature, matching instance, fresh state revision/digest, acceptable epoch,
anti-replay checks, and revocation status. A grant cannot be accepted without
being delivered through the control-plane boundary.

## Trust and authorization

The issuer remains the sole grant signer and epoch owner. The control plane
does not duplicate signing, epoch, persistence, or audit logic. Caller
authentication and authorization are injected through the 053J authorizer.
Candidate self-issuance, DHT observations, reachability, heartbeats, latest
revision, and process state have no authority meaning.

No unauthenticated HTTP endpoint or force-promote shortcut exists. A future
transport adapter must preserve explicit caller authentication, authorization,
bounded payloads, replay protection, and sanitized errors.

## Revocation and persistence

Revocation delegates to the issuer and then explicitly demotes the candidate.
Candidate validation can use an injected revocation lookup. If lookup is
unavailable or throws, acceptance fails closed. Distributed revocation
propagation is not implemented.

Issuer and candidate continue using their existing durable atomic persistence.
The control plane creates no competing authority store. Restart preserves the
issuer epoch/audits/revocations and candidate accepted or revoked state.

## Split-brain and non-goals

Wrong identities, issuers, signatures, epochs, revisions, digests, timestamps,
replayed/conflicting/revoked grants, and ambiguous authority states are
rejected. No other coordinator becomes authoritative automatically.

053K does not implement election, quorum, Raft/consensus, leases, fencing,
automatic failover, DHT authority, client coordinator failover, or force
promotion. A future automation or consensus layer may plug into the explicit
control-plane contract only after defining authority epoch ownership,
split-brain exclusion, revocation distribution, and durable audit semantics.
