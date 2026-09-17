# 054: coordinator recovery operational drill

## Purpose

This milestone wraps the existing 053Q authority recovery policy with an explicit operational drill layer. The drill is not an autonomous authority mechanism. It is a controlled, auditable, and reversible workflow used to inspect, diagnose, prepare, execute, and verify a recovery action while the underlying 053Q policy enforces the actual authority boundary.

## Safety model

The operational drill is intentionally non-authoritative:

- it never creates an authority epoch
- it never promotes a coordinator to authoritative status on its own
- it never bypasses the 053Q evidence + authorization checks
- it never auto-fires a recovery action in background workers
- it requires explicit operator intent for sensitive steps

The actual authority boundary remains in `packages/coordinator-ha/authority-recovery-policy.ts` and is enforced by runtime and control-plane calls.

## Recovery state machine

The drill uses the following deterministic states and legal transitions:

- idle
- degraded
- diagnosed
- authorization-required
- authorized
- executing
- recovered
- verification-failed
- interrupted
- aborted
- rejected

Legal transition summary:

| From | To | Allowed |
|---|---|---|
| idle | degraded, diagnosed, authorization-required, rejected | yes |
| degraded | diagnosed, authorization-required, rejected | yes |
| diagnosed | authorization-required, authorized, rejected, degraded | yes |
| authorization-required | authorized, rejected, interrupted, degraded, aborted | yes |
| authorized | executing, rejected, interrupted, degraded, aborted | yes |
| executing | recovered, verification-failed, interrupted, rejected, aborted, degraded | yes |
| recovered | verification-failed, rejected, degraded | yes |
| verification-failed | rejected, degraded, diagnosed | yes |
| interrupted | diagnosed, authorization-required, rejected, degraded, aborted | yes |
| aborted | rejected, degraded, diagnosed | yes |
| rejected | diagnosed, authorization-required, interrupted, degraded | yes |

Illegal transitions are rejected and persisted only through the safe minimum state record.

## Evidence model

The drill consumes the same current evidence that 053Q uses:

- issuer identity
- issuer initialization
- persistence health
- candidate identity
- authority epoch
- state revision and digest
- ownership state and conflict bits
- valid grant / grant revocation
- freshness and stale evidence detection

If any evidence is missing, stale, conflicting, corrupted, or mismatched, the drill transitions into degraded or rejected state without mutating authority.

## Operator authorization

The drill requires an explicit `RecoveryOperatorAuthorization` which must remain bound to:

- exact candidate instance identity
- exact issuer instance identity
- exact authority epoch
- exact state revision
- exact state digest
- exact evidence
- bounded issuedAt/expiresAt
- valid signature
- non-revoked, non-replayed, non-expired authorization

The candidate cannot self-authorize, and a single authorization cannot be reused across a different candidate or later epoch.

## Operational workflow

1. inspectRecoveryDrill / inspect
   - read-only snapshot
   - no mutation

2. diagnoseRecovery
   - evaluate current runtime evidence and recovery policy state
   - identify authorization requirement, stale or conflicted recovery, or degraded persistence

3. prepareRecovery
   - require explicit authorization
   - do not change ownership or authoritative state

4. executeRecoveryDrill
   - revalidate current evidence and authorization
   - require 053Q approval path before any explicit recovery action
   - only accept "inspect", "approve", "reset", or "fence" actions

5. verifyRecovery
   - verify that recovery remains bound to current evidence and authority
   - fail closed if verification does not prove a single authoritative owner

## Degraded-state mechanism

The drill supports a deterministic degraded state in the subprocess harness by writing invalid issuer persistence and then routing the runtime/control-plane through the same diagnosis and 053Q evaluation path. This does not promote or recover authority; it simply yields the exact recovery reason/state required by the policy.

## Persistence and restart behavior

Drill state is stored atomically with restrictive permissions, fsync, temp-file write, and rename semantics. The stored state is intentionally minimal and excludes secrets or signatures.

On restart:

- executing / intermediate state does not auto-resume mutation
- the operator must explicitly continue or reject the drill
- corrupt stored drill state fails closed
- missing persistence simply leaves the drill idle or uninitialized

## Observability

The drill emits sanitized EventStore events and bounded MetricsRegistry counters. Conditions are updated only with safe recovery states and never grant authority.

Sanitized observability excludes:

- private keys
- signatures
- authorization credentials
- ownership tokens
- raw persistence contents
- sensitive file paths

## Cross-process safety

The drill remains subject to the 053Q invariant:

- one authorization is not enough by itself to create authority ownership
- the candidate must still bind to the exact issuer, epoch, revision, digest, and current evidence
- same authorization cannot produce two authority owners for the same epoch
- ownership fencing prevents a second owner from becoming authoritative

## Explicit non-goals

The drill does not add:

- automatic promotion
- election or failover logic
- DHT authority
- background recovery tasks
- unauthenticated mutation endpoints
- new crypto or authority issuance paths

## Related files

- `packages/coordinator-ha/authority-recovery-policy.ts`
- `packages/coordinator-ha/authority-recovery-drill.ts`
- `packages/coordinator-ha/authority-control-plane.ts`
- `packages/coordinator-ha/runtime.ts`
- `packages/coordinator-ha/runtime-process-worker.ts`
- `packages/coordinator-ha/runtime-process.test.ts`
