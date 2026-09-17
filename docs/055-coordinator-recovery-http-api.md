# OpenStore 055: coordinator recovery HTTP API

## 1. Purpose and architecture

This API is a thin HTTP adapter over the production authority recovery path. It does not implement authority policy on its own, does not create authority, and does not bypass the existing 053Q enforcement boundary.

The real enforcement path is:

- `packages/registry/coordinator.ts` exposes the HTTP routes.
- `packages/coordinator-ha/authority-control-plane.ts` owns the live control-plane operations.
- `packages/coordinator-ha/authority-recovery-policy.ts` enforces the actual recovery policy and authorization checks.
- `packages/coordinator-ha/authority-recovery-drill.ts` provides the inspect/diagnose/prepare/execute/verify drill semantics and state transitions.
- `packages/coordinator-ha/runtime.ts` exposes the runtime status and runtime recovery inspection path.

HTTP is only an adapter. Its role is to enforce the coordinator bearer-token auth boundary, validate body shape, normalize the payload into a safe response, and delegate to the real runtime/control-plane implementation.

## 2. Exact routes

The implemented routes are all under `/v1/recovery`:

- `GET /v1/recovery/inspect?evidence=<JSON>`
- `POST /v1/recovery/diagnose`
- `POST /v1/recovery/prepare`
- `POST /v1/recovery/execute`
- `POST /v1/recovery/verify`

The coordinator server also supports the standard registry routes, but the recovery-specific endpoints are the ones above.

## 3. Existing authentication mechanism

The registry coordinator accepts a configured `token` string in `createRegistryCoordinator({ token: ... })` and enforces bearer auth before recovery routes are processed.

The actual requirement is:

- `Authorization: Bearer <token>`
- If the configured token is set and the header does not exactly match, the request is rejected with `401` and `{"error":"unauthorized"}`.

No recovery route bypasses this coordinator-level auth guard.

## 4. Request validation

The HTTP layer validates input in the real server handler:

- recovery routes require a valid JSON object body for `POST` requests.
- invalid JSON is rejected with `400` and a `malformed_request` or `invalid_request` reason.
- oversized request bodies are rejected with `400` when they exceed `maxBodyBytes` (default `1 MiB`).
- missing evidence is rejected with `400` and a `missing_evidence` or `invalid_request` reason.
- missing or malformed authorization entries are rejected as validation failures by the control-plane/recovery policy.
- `GET /v1/recovery/inspect` reads `evidence` from the query string and parses it as JSON; invalid JSON throws and is mapped to a rejected result.

The route implementation does not trust client-provided evidence or authorization. Every recovery decision is delegated to the live policy and drill logic.

## 5. Safe response structure

The HTTP adapter normalizes the underlying recovery result through `sanitizeRecoveryPayload()` before returning it to the client. The safe public payload is intentionally reduced to a small, typed structure:

```json
{
  "state": "authorized | recovered | rejected | authorization-required | degraded | conflicted | ...",
  "reason": "normalized_reason",
  "decision": "allowed | denied | requires_operator_authorization",
  "authorized": true,
  "executed": true,
  "verified": true,
  "authorizationRequired": true,
  "recoveryState": "...",
  "recoveryReason": "...",
  "persisted": true,
  "persistenceState": "...",
  "ownershipConflict": false,
  "observedAt": 1234567890
}
```

The adapter intentionally does not return raw internal persistence, raw authorization credentials, signatures, private keys, DEKs, recovery phrases, ownership tokens, or untrusted filesystem state. It also normalizes many legacy/internal reason strings into stable external values such as:

- `operator_authorization_required`
- `invalid_authorization`
- `authorization_expired`
- `authorization_revoked`
- `missing_evidence`
- `stale_evidence`
- `ownership_conflict`
- `validation_failed`
- `corrupt_persistence`
- `replay_detected`
- `verification_failed`

## 6. HTTP status/error behavior actually implemented

The real HTTP adapter classifies failures to stable status codes using `classifyRecoveryFailure()` and `resolveRecoveryStatus()`.

Status mapping used by the code:

- `401` — unauthorized coordinator token
- `400` — invalid JSON, malformed request, missing evidence, verification failure during `verify`
- `403` — authorization required
- `422` — invalid authorization, expired authorization, revoked authorization, stale evidence, bad evidence binding, validation failure
- `409` — aborted/interrupted or verification_failed states
- `503` — degraded runtime, corrupt persistence, or ownership conflict
- `200` — normal success or information-only result path

The actual route handler keeps the status code consistent with the sanitized payload, and it does not convert a rejected recovery result into a fake success.

## 7. Recovery lifecycle and allowed transitions

The operation flow exposed by HTTP is the same operational drill flow used by the production implementation:

1. `inspect` — read-only evaluation of current evidence.
2. `diagnose` — evaluate current evidence and determine recovery reason.
3. `prepare` — require an explicit operator authorization and validate it; no ownership mutation occurs here.
4. `execute` — revalidate current evidence and authorization, then invoke the real explicit recovery action path.
5. `verify` — confirm ownership, persistence, and authorization replay protection.

The drill does not auto-advance or auto-resume on restart. The drill layer requires explicit operator action before authority-changing mutation is allowed.

## 8. How HTTP delegates to runtime/control-plane/recovery-drill

The route handler dispatches to the live production services in `handle()` inside `packages/registry/coordinator.ts`:

- `GET /v1/recovery/inspect` -> `authorityRuntime?.inspectRecovery(...)` or `authorityControlPlane?.inspectRecovery(...)`
- `POST /v1/recovery/diagnose` -> `authorityRuntime?.diagnoseRecoveryDrill(...)` or `authorityControlPlane?.diagnoseRecoveryDrill(...)`
- `POST /v1/recovery/prepare` -> `authorityControlPlane?.prepareRecoveryDrill(evidence, authorization)`
- `POST /v1/recovery/execute` -> `authorityControlPlane?.executeRecoveryDrill(action, evidence, authorization)`
- `POST /v1/recovery/verify` -> `authorityControlPlane?.verifyRecoveryDrill(evidence, authorization)`

The actual policy and drill implementations are in the coordinator HA layer. This route is not a separate policy; it delegates to the real code paths that enforce the 053Q boundary and the 054 drill semantics.

## 9. 053Q enforcement boundary

HTTP does not bypass 053Q.

The 053Q enforcement boundary is the policy layer in `authority-recovery-policy.ts` and the runtime/control-plane enforcement path in `runtime.ts` and `authority-control-plane.ts`.

Before any authority-relevant operation is allowed, the system checks:

- exact candidate binding
- exact issuer binding
- exact authority epoch
- exact state revision
- exact state digest
- current evidence freshness
- authorization validity
- expiry and revocation
- replay/consumption rules
- ownership fencing and conflict checks

The coordinator HTTP layer simply exposes and sanitizes these real checks to the external caller.

## 10. Replay, expiry, revocation, and evidence binding

The actual contract enforces the same protection used by the live policy:

- expired authorization is rejected with `422` and an `authorization_expired` style reason
- revoked authorization is rejected with `422` and an `authorization_revoked` style reason
- replayed authorization is rejected with `422` and a rejected state; the route cannot double-execute the same mutation
- mismatched epoch/revision/digest are rejected with `422`
- wrong candidate/issuer binding is rejected as invalid authorization or validation failure
- active ownership conflict is rejected with `503` and `ownership_conflict`

For `verify`, an execution must already have succeeded; otherwise the server returns a rejected payload and a `400` result.

## 11. Ownership/split-brain protections

This HTTP adapter does not create authority by itself, and it is not allowed to treat a valid authorization as sufficient owner creation.

The production logic requires the candidate to still satisfy the exact policy requirements before the recovery action can proceed. The same authorization cannot be reused to create two independent owners, and the ownership path remains fail-closed under cross-process race conditions.

There is no automatic election, promotion, failover, or DHT authority mechanism in this layer.

## 12. Sensitive-data redaction

The adapter redacts/normalizes sensitive material before sending a response. In particular:

- no private keys
- no recovery phrases
- no DEKs
- no signature values
- no authorization credential material
- no internal persistence payloads
- no ownership tokens
- no raw recovery evidence is returned as-is

The `sanitizeRecoveryPayload()` helper is the actual public boundary. It does not echo the raw request body back to the caller.

## 13. No automatic promotion/election/failover

This path intentionally does not implement automatic authority promotion, authority election, failover, or any external DHT authority change.

The coordinator HTTP layer only exposes the controlled operational drill and explicit recovery decisions already enforced in the production control plane.

## 14. Restart/no-auto-resume behavior

The route does not resume a partial drill automatically after restart.

The live test coverage checks that after a successful recovery or recovery attempt, a later restart does not automatically restore or resume an authority-changing mutation. The runtime and control plane remain explicit and fail-closed; subsequent recovery actions must be made under the same validation boundary again.

## 15. Exact manual HTTP verification commands actually used

The live verification commands in the test harness are implemented as direct `fetch()` requests against the running local coordinator server. They are the actual commands used to exercise the production route behavior.

Examples from the live test file `packages/registry/coordinator-recovery-http.test.ts`:

```ts
const response = await fetch(`${server.baseUrl}/v1/recovery/inspect?evidence=${encodeURIComponent(JSON.stringify(server.evidence))}`, {
  headers: { authorization: `Bearer ${server.token}` },
});
```

```ts
const response = await httpJson(`${server.baseUrl}/v1/recovery/diagnose`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ evidence: server.evidence }),
});
```

```ts
const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization }),
});
```

```ts
const response = await httpJson(`${server.baseUrl}/v1/recovery/execute`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ evidence: server.evidence, action: "approve", authorization: server.authorization }),
});
```

```ts
const verify = await httpJson(`${server.baseUrl}/v1/recovery/verify`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization }),
});
```

Equivalent `curl` commands are structurally the same, but the repo verification path that was actually executed used the `fetch()` calls above against the live coordinator server instance.

## 16. Known limitations

- This is not a general-purpose authority election layer; it is a specific recovery adapter over the existing 053Q authority policy.
- The HTTP layer cannot create authority without the live policy/control-plane checks.
- The adapter is designed for the current coordinator runtime and does not add new authority semantics.
- The live contract is intentionally conservative; it fails closed on malformed, expired, revoked, replayed, or mismatched requests.
- The route names are fixed and limited to the implemented set above.

## 17. Summary

The 055 HTTP contract is intentionally narrow and fail-closed: it authenticates at the coordinator boundary, sanitizes the output, delegates to the production authority policy/runtime/drill implementation, and rejects any request that fails the exact 053Q/054 safety checks. It does not add a stronger authority mechanism; it exposes the existing live authority recovery path through HTTP in a safe, audited, and replay-resistant form.
