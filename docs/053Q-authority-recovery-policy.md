# 053Q: Authority Recovery Policy & Operator Safety

## Problem and threat model

Authority recovery is exceptional and must never become an automatic promotion path. The runtime may only recover from exceptional or degraded state when the system has fresh valid evidence and an explicit, validated operator authorization bound to the exact authority epoch, candidate instance, state revision, and state digest.

This milestone preserves the fail-closed authority model from 053N/053P:

- no automatic promotion
- no election or quorum
- no DHT-based authority
- no hidden failover
- no candidate self-authorization
- no silent repair of corrupt state
- no implicit operator trust

## Recovery evidence

Recovery decisions evaluate the current authority stack instead of manufacturing synthetic evidence. Required evidence includes:

- issuer initialized and healthy
- issuer identity matches trusted instance
- candidate instance identity matches the expected runtime
- authority epoch consistency
- state revision and digest match the candidate snapshot
- grant validity and revocation status
- ownership state, fencing, and conflict
- persistence health and corruption/missing-state classification
- freshness and staleness checks

Missing, stale, corrupt, conflicted, expired, mismatched, or revoked evidence yields a fail-closed result.

## Operator authorization model

Recovery requires an explicit `RecoveryOperatorAuthorization` signed by the trusted issuer identity. The authorization is bound to:

- `candidateInstanceId`
- `issuerInstanceId`
- `authorityEpoch`
- `stateRevision`
- `stateDigest`
- `operatorIdentity`
- bounded `issuedAt` / `expiresAt`
- unique `authorizationId`
- replay nonce, where present

The authorization must also satisfy:

- candidate may not self-authorize
- authorization must match the current recovery evidence exactly
- authorization must not be expired or revoked
- authorization must be verified by the authoritative issuer signature
- replayed or reused authorization does not authorize another recovery action

## State machine

The state machine is deterministic and intentionally narrow:

| State | Meaning | Allowed transitions |
| --- | --- | --- |
| unavailable | runtime or persistence is not healthy enough for recovery | missing-evidence, rejected |
| missing-evidence | required evidence is absent or invalid | rejected, authorization-required |
| stale | evidence is older than the freshness window or mismatched to current epoch | rejected, authorization-required |
| conflicted | ownership or state is conflicted/fenced | rejected |
| authorization-required | valid evidence exists but explicit operator authorization is needed | authorized, rejected |
| authorized | valid evidence and valid authorization are present | recovered, rejected |
| recovered | explicit recovery action succeeded | rejected |
| rejected | fail-closed rejection | none |

Invalid transitions are rejected and cannot silently promote authority.

## Runtime/control-plane integration

The policy is enforced at the real runtime and control-plane boundary, not as an isolated helper.

- `runtime.ts` consults the recovery policy during startup and recovery checks.
- `authority-control-plane.ts` exposes typed recovery operations and validates their evidence and authorization before state-changing steps.
- The runtime still preserves the 053N/053P valid restoration semantics.
- Recovery actions remain explicit and auditable; no background or automatic execution occurs.

## Persistence and restart behavior

Authorization and revocation records are persisted with restrictive file permissions and atomic rename semantics. The policy loads persisted state and treats corrupt or unreadable data as fail-closed. Missing state does not create authority. Valid state survives restart and retains revocation coverage.

## Same-authorization / two-candidate invariant

The recovery authorization is not a capability that grants authority by itself. It is an explicit operator decision bound to one exact candidate instance and one exact authority epoch/state snapshot. The policy requires the authorization to match the current evidence exactly, including candidate instance ID, issuer instance ID, epoch, revision, digest, and validity of the underlying grant/ownership state.

This means the same authorization cannot silently authorize two authority owners:

- candidate A may use the authorization only if its instance ID, epoch, revision, digest, and evidence all match the authorization exactly.
- candidate B cannot use candidate A's authorization because the binding check fails before any authority-changing step.
- if both candidates race to recover with the same authorization, the ownership persistence and fencing rules still reject a second owner in the same epoch.
- a consumed, revoked, or replayed authorization remains unusable after restart.

## Observability

The real recovery flow emits sanitized EventStore events, bounded MetricsRegistry counters, and deterministic conditions without exposing:

- private keys
- authorization credentials
- raw signatures
- grant bodies
- ownership tokens
- file system paths or raw persistence contents

## Non-goals

- no automatic promotion
- no election or quorum
- no automatic failover
- no DHT authority
- no client placement behavior changes
- no unauthenticated authority mutation
- no hidden state repair

## Implementation note

053Q is intentionally scoped to the authority recovery boundary and does not alter the underlying storage, networking, or economics architecture.
