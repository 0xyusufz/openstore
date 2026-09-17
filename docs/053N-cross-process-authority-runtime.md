# Milestone 053N: Cross-Process Authority Runtime Integration

053N adds `CoordinatorAuthorityRuntime`, a lifecycle adapter around the
existing 053I–053M issuer, candidate, control-plane, and ownership services.
It keeps authority persistence separate from the ordinary registry/node
registry and does not duplicate coordinator state.

## Lifecycle and restoration

Startup is explicit and deterministic. An issuer must be initialized before
any persisted authority can be restored or exposed. The runtime validates
persistence health and requires the issuer epoch, candidate epoch, ownership
epoch, and ownership issuer identity to agree before exposing authority.
Missing issuer/candidate/ownership state remains non-authoritative; corrupt
state enters `degraded` and cannot silently manufacture an epoch, owner, grant,
or promotion.

`stop()` is idempotent and has no background authority loop. The existing HA
integration adapter can optionally own this runtime and awaits `start()` before
replica synchronization and awaits `stop()` before completing shutdown. The
default coordinator path does not construct or invoke an authority runtime.

## Explicit operations

Runtime methods delegate to the existing control plane:

- inspect status;
- validate an ownership token;
- establish ownership from an already delivered, externally issued grant;
- release ownership;
- fence the current owner.

No issuance, self-promotion, automatic promotion, or automatic failover is
performed. Mutation remains programmatic/in-process because the existing
coordinator HTTP API does not provide a suitable authenticated operator
control-plane protocol; no unauthenticated endpoint was added.

## Fail-closed behavior

Issuer persistence degradation, revoked/expired grants, wrong epochs,
conflicting ownership, stale state, invalid signatures, replayed/fenced
tokens, and corrupt persistence prevent authority establishment. Status is
bounded and sanitized: it exposes lifecycle, authority classification,
instance/epoch metadata, ownership state, and persistence health, never tokens,
private keys, credentials, or persistence contents.

Existing registry placement, client outage semantics, DHT discovery boundary,
and replica non-authority remain unchanged. Future cross-process transport
must preserve authenticated explicit control, durable ownership evidence,
revocation checks, and split-brain exclusion.
