import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { signMessage, verifyMessage } from "../identity/index.js";
import type { EventStore } from "../events/index.js";
import type { MetricsRegistry } from "../metrics/index.js";
import type { ConditionEvaluator } from "../conditions/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";

export type AuthorityRecoveryDecision = "allowed" | "denied" | "requires_operator_authorization" | "blocked";
export type AuthorityRecoveryState = "unavailable" | "missing-evidence" | "stale" | "conflicted" | "authorization-required" | "authorized" | "recovered" | "rejected";
export type AuthorityRecoveryReason =
  | "missing_issuer"
  | "uninitialized_issuer"
  | "corrupt_issuer"
  | "corrupt_candidate"
  | "corrupt_ownership"
  | "epoch_mismatch"
  | "issuer_identity_mismatch"
  | "ownership_conflict"
  | "validation_failure"
  | "authorization_required"
  | "stale_evidence"
  | "invalid_evidence"
  | "conflicted_evidence"
  | "authorization_revoked"
  | "authorization_expired"
  | "authorization_invalid"
  | "missing_evidence"
  | "authorization_accepted";

export interface AuthorityRecoveryEvidence {
  readonly version: 1;
  readonly issuerInstanceId: string;
  readonly issuerInitialized: boolean;
  readonly issuerPersistenceState: "missing" | "valid" | "corrupt";
  readonly candidateInstanceId: string;
  readonly authorityEpoch: number;
  readonly candidateEpoch: number;
  readonly candidateState: "non-authoritative" | "authoritative" | "revoked";
  readonly ownershipState: "non-authoritative" | "authoritative" | "released" | "fenced";
  readonly ownershipEpoch?: number;
  readonly ownerInstanceId?: string;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly stateFresh: boolean;
  readonly validGrant: boolean;
  readonly grantRevoked: boolean;
  readonly issuerIdentityMatches: boolean;
  readonly persistedStateHealthy: boolean;
  readonly activeOwnershipConflict: boolean;
}

export interface RecoveryOperatorAuthorizationRequest {
  readonly version: 1;
  readonly candidateInstanceId: string;
  readonly authorityEpoch: number;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly issuerInstanceId: string;
  readonly operatorIdentity: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce?: string;
}

export interface RecoveryOperatorAuthorization extends RecoveryOperatorAuthorizationRequest {
  readonly authorizationId: string;
  readonly signature: string;
}

export interface AuthorityRecoveryPolicyEvaluation {
  readonly decision: AuthorityRecoveryDecision;
  readonly state: AuthorityRecoveryState;
  readonly reason: AuthorityRecoveryReason;
  readonly requiresOperatorAuthorization: boolean;
  readonly authorized: boolean;
}

export interface AuthorityRecoveryPolicyInspection {
  readonly lastDecision: AuthorityRecoveryDecision;
  readonly lastState: AuthorityRecoveryState;
  readonly lastReason: AuthorityRecoveryReason;
  readonly persistedStateHealthy: boolean;
  readonly persistenceState: "missing" | "valid" | "corrupt";
  readonly authorizations: readonly RecoveryOperatorAuthorization[];
  readonly revokedAuthorizationIds: readonly string[];
  readonly lastAction?: string;
}

export interface AuthorityRecoveryPolicy {
  evaluateRecovery(evidence: AuthorityRecoveryEvidence | undefined, authorization?: RecoveryOperatorAuthorization): AuthorityRecoveryPolicyEvaluation;
  requestAuthorization(request: RecoveryOperatorAuthorizationRequest): Promise<RecoveryOperatorAuthorization>;
  approveRecovery(evidence: AuthorityRecoveryEvidence, authorization: RecoveryOperatorAuthorization): AuthorityRecoveryPolicyEvaluation;
  rejectAuthorization(authorizationId: string, reason: string): Promise<void>;
  executeExplicitRecoveryAction(action: "inspect" | "approve" | "reset" | "fence", evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): AuthorityRecoveryPolicyEvaluation;
  inspect(): AuthorityRecoveryPolicyInspection;
}

export interface AuthorityRecoveryPolicyOptions {
  readonly issuerIdentity: { publicKey: Buffer; privateKey: Buffer };
  readonly issuerInstanceId: string;
  readonly candidateInstanceId: string;
  readonly persistencePath?: string;
  readonly now?: () => number;
  readonly events?: EventStore;
  readonly metrics?: MetricsRegistry;
  readonly conditions?: ConditionEvaluator;
}

export interface AuthorityRecoveryStateInput {
  readonly initialized: boolean;
  readonly issuerInstanceId: string;
  readonly issuerPersistenceHealthy: boolean;
  readonly issuerPersistenceState: "missing" | "valid" | "corrupt";
  readonly authorityEpoch: number;
  readonly candidateInstanceId: string;
  readonly candidateEpoch: number;
  readonly candidateState: "non-authoritative" | "authoritative" | "revoked";
  readonly candidatePersistenceHealthy: boolean;
  readonly candidatePersistenceState: "missing" | "valid" | "corrupt";
  readonly ownershipState: "non-authoritative" | "authoritative" | "released" | "fenced";
  readonly ownershipEpoch?: number;
  readonly ownerInstanceId?: string;
  readonly ownershipPersistenceHealthy: boolean;
  readonly ownershipPersistenceState: "missing" | "valid" | "corrupt";
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly stateFresh: boolean;
  readonly validGrant: boolean;
  readonly grantRevoked: boolean;
  readonly issuerIdentityMatches: boolean;
  readonly persistedStateHealthy: boolean;
  readonly activeOwnershipConflict: boolean;
}

export function buildAuthorityRecoveryEvidence(input: AuthorityRecoveryStateInput): AuthorityRecoveryEvidence {
  return Object.freeze({
    version: 1,
    issuerInstanceId: input.issuerInstanceId,
    issuerInitialized: input.initialized,
    issuerPersistenceState: input.issuerPersistenceState,
    candidateInstanceId: input.candidateInstanceId,
    authorityEpoch: input.authorityEpoch,
    candidateEpoch: input.candidateEpoch,
    candidateState: input.candidateState,
    ownershipState: input.ownershipState,
    ownershipEpoch: input.ownershipEpoch,
    ownerInstanceId: input.ownerInstanceId,
    stateRevision: input.stateRevision,
    stateDigest: input.stateDigest,
    stateFresh: input.stateFresh,
    validGrant: input.validGrant,
    grantRevoked: input.grantRevoked,
    issuerIdentityMatches: input.issuerIdentityMatches,
    persistedStateHealthy: input.persistedStateHealthy,
    activeOwnershipConflict: input.activeOwnershipConflict,
  });
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CANDIDATE = /^coord-[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().reduce<Record<string, unknown>>((out, key) => {
    out[key] = value[key]; return out;
  }, {}));
}

function signingPayload(request: Omit<RecoveryOperatorAuthorization, "signature">): Buffer {
  return Buffer.from(`OPENSTORE-AUTHORITY-RECOVERY-V1\n${canonical({ ...request })}`, "utf8");
}

function isValidEvidence(input: AuthorityRecoveryEvidence | undefined): boolean {
  if (!input) return false;
  return input.version === 1 && CANDIDATE.test(input.issuerInstanceId) && CANDIDATE.test(input.candidateInstanceId) &&
    Number.isSafeInteger(input.authorityEpoch) && input.authorityEpoch >= 0 &&
    Number.isSafeInteger(input.stateRevision) && input.stateRevision >= 0 &&
    DIGEST.test(input.stateDigest) && typeof input.stateFresh === "boolean" &&
    typeof input.validGrant === "boolean" && typeof input.grantRevoked === "boolean" &&
    typeof input.issuerIdentityMatches === "boolean" && typeof input.persistedStateHealthy === "boolean" &&
    typeof input.activeOwnershipConflict === "boolean" &&
    ["missing", "valid", "corrupt"].includes(input.issuerPersistenceState);
}

export function createAuthorityRecoveryPolicy(options: AuthorityRecoveryPolicyOptions): AuthorityRecoveryPolicy {
  const now = options.now ?? (() => Date.now());
  if (!options.issuerIdentity || !options.issuerIdentity.publicKey || !options.issuerIdentity.privateKey) throw new TypeError("recovery policy requires an issuer identity");
  const issuerIdentity = createCoordinatorInstanceIdentity(options.issuerIdentity.publicKey);
  if (issuerIdentity.instanceId !== options.issuerInstanceId) throw new TypeError("recovery policy issuer identity does not match issuer instance");
  const metric = (name: string, labels?: Record<string, string>): void => {
    try { options.metrics?.increment(name, 1, labels ?? {}); } catch { /* observability cannot alter safety */ }
  };
  const event = (type: string, severity: "info" | "warning" | "error", details: Record<string, string | number | boolean> = {}): void => {
    try { options.events?.append({ version: 1, timestamp: now(), component: "coordinator", type: type as never, severity, details }); } catch { /* observability cannot alter safety */ }
  };
  let _lastDecision: AuthorityRecoveryDecision = "denied";
  let _lastState: AuthorityRecoveryState = "missing-evidence";
  let _lastReason: AuthorityRecoveryReason = "missing_evidence";
  let _lastAction: string | undefined;
  let persistenceHealthy = true;
  let persistenceState: "missing" | "valid" | "corrupt" = "missing";
  const authorizations = new Map<string, RecoveryOperatorAuthorization>();
  const revoked = new Set<string>();

  const load = (): void => {
    if (!options.persistencePath) return;
    try {
      const parsed = JSON.parse(readFileSync(options.persistencePath, "utf8")) as { version: 1; authorizations?: RecoveryOperatorAuthorization[]; revoked?: string[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.authorizations) || !Array.isArray(parsed.revoked)) throw new Error("invalid recovery policy persistence");
      for (const record of parsed.authorizations) {
        if (!record || !ID.test(record.authorizationId) || !ID.test(record.operatorIdentity) || !DIGEST.test(record.stateDigest)) continue;
        authorizations.set(record.authorizationId, Object.freeze({ ...record }));
      }
      for (const id of parsed.revoked) if (typeof id === "string" && ID.test(id)) revoked.add(id);
      persistenceState = "valid";
    } catch {
      persistenceHealthy = !existsSync(options.persistencePath);
      persistenceState = persistenceHealthy ? "missing" : "corrupt";
    }
  };

  const persist = (): void => {
    if (!options.persistencePath) return;
    const path = options.persistencePath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, "wx", 0o600);
    const payload = { version: 1, authorizations: [...authorizations.values()], revoked: [...revoked] };
    try {
      writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8"); fsyncSync(fd); closeSync(fd); chmodSync(temp, 0o600); renameSync(temp, path);
      const directoryFd = openSync(dirname(path), "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      persistenceHealthy = true; persistenceState = "valid";
    } catch (error) {
      try { closeSync(fd); } catch {}
      try { unlinkSync(temp); } catch {}
      persistenceHealthy = false; persistenceState = "corrupt"; throw error;
    }
  };

  const recordCondition = (state: AuthorityRecoveryState): void => {
    try {
      options.conditions?.evaluate({ authority: { recoveryState: state } }, now());
    } catch { /* observability cannot alter safety */ }
  };

  const evaluate = (evidence: AuthorityRecoveryEvidence | undefined, authorization?: RecoveryOperatorAuthorization): AuthorityRecoveryPolicyEvaluation => {
    const safeEvidence = evidence;
    if (persistenceState === "corrupt" || (options.persistencePath && !persistenceHealthy && existsSync(options.persistencePath))) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = "corrupt_issuer";
      metric("authority_recovery_decisions_total", { reason: "corrupt_issuer" });
      event("authority.recovery.blocked", "error", { classification: "corrupt_issuer", state: "rejected" });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: "corrupt_issuer", requiresOperatorAuthorization: false, authorized: false };
    }
    if (safeEvidence === undefined || !isValidEvidence(safeEvidence)) {
      _lastDecision = "denied"; _lastState = "missing-evidence"; _lastReason = "missing_evidence";
      metric("authority_recovery_decisions_total", { reason: "missing_evidence" });
      event("authority.recovery.blocked", "warning", { classification: "missing_evidence", state: "missing-evidence" });
      recordCondition(_lastState);
      return { decision: "denied", state: "missing-evidence", reason: "missing_evidence", requiresOperatorAuthorization: false, authorized: false };
    }
    if (safeEvidence.issuerPersistenceState === "corrupt") {
      _lastDecision = "blocked"; _lastState = "unavailable"; _lastReason = "corrupt_issuer";
      metric("authority_recovery_decisions_total", { reason: "corrupt_issuer" });
      event("authority.recovery.blocked", "error", { classification: "corrupt_issuer", state: "unavailable" });
      recordCondition(_lastState);
      return { decision: "blocked", state: "unavailable", reason: "corrupt_issuer", requiresOperatorAuthorization: false, authorized: false };
    }
    if (!safeEvidence.issuerInitialized) {
      _lastDecision = "denied"; _lastState = "missing-evidence"; _lastReason = "uninitialized_issuer";
      metric("authority_recovery_decisions_total", { reason: "uninitialized_issuer" });
      event("authority.recovery.blocked", "warning", { classification: "uninitialized_issuer", state: "missing-evidence" });
      recordCondition(_lastState);
      return { decision: "denied", state: "missing-evidence", reason: "uninitialized_issuer", requiresOperatorAuthorization: false, authorized: false };
    }
    if (!safeEvidence.persistedStateHealthy || !safeEvidence.issuerIdentityMatches || safeEvidence.candidateInstanceId !== options.candidateInstanceId || safeEvidence.issuerInstanceId !== options.issuerInstanceId) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = safeEvidence.issuerIdentityMatches ? "validation_failure" : "issuer_identity_mismatch";
      metric("authority_recovery_decisions_total", { reason: _lastReason });
      event("authority.recovery.blocked", "error", { classification: _lastReason, state: "rejected" });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: _lastReason, requiresOperatorAuthorization: false, authorized: false };
    }
    if (!safeEvidence.stateFresh) {
      _lastDecision = "blocked"; _lastState = "stale"; _lastReason = "stale_evidence";
      metric("authority_recovery_decisions_total", { reason: "stale_evidence" });
      event("authority.recovery.blocked", "warning", { classification: "stale_evidence", state: "stale" });
      recordCondition(_lastState);
      return { decision: "blocked", state: "stale", reason: "stale_evidence", requiresOperatorAuthorization: false, authorized: false };
    }
    if (safeEvidence.activeOwnershipConflict || safeEvidence.ownershipState === "fenced") {
      _lastDecision = "blocked"; _lastState = "conflicted"; _lastReason = "ownership_conflict";
      metric("authority_recovery_decisions_total", { reason: "ownership_conflict" });
      event("authority.recovery.blocked", "error", { classification: "ownership_conflict", state: "conflicted" });
      recordCondition(_lastState);
      return { decision: "blocked", state: "conflicted", reason: "ownership_conflict", requiresOperatorAuthorization: false, authorized: false };
    }
    if (!safeEvidence.validGrant || safeEvidence.grantRevoked || safeEvidence.candidateEpoch !== safeEvidence.authorityEpoch || (typeof safeEvidence.ownershipEpoch === "number" && safeEvidence.ownershipEpoch !== safeEvidence.authorityEpoch)) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = safeEvidence.grantRevoked ? "validation_failure" : safeEvidence.candidateEpoch !== safeEvidence.authorityEpoch || (typeof safeEvidence.ownershipEpoch === "number" && safeEvidence.ownershipEpoch !== safeEvidence.authorityEpoch) ? "epoch_mismatch" : "invalid_evidence";
      metric("authority_recovery_decisions_total", { reason: _lastReason });
      event("authority.recovery.blocked", "error", { classification: _lastReason, state: "rejected" });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: _lastReason, requiresOperatorAuthorization: false, authorized: false };
    }
    if (!authorization) {
      _lastDecision = "requires_operator_authorization"; _lastState = "authorization-required"; _lastReason = "authorization_required";
      metric("authority_recovery_decisions_total", { reason: "authorization_required" });
      event("authority.recovery.authorization.requested", "info", { classification: "authorization_required", state: "authorization-required", epoch: safeEvidence.authorityEpoch });
      recordCondition(_lastState);
      return { decision: "requires_operator_authorization", state: "authorization-required", reason: "authorization_required", requiresOperatorAuthorization: true, authorized: false };
    }
    if (authorization.candidateInstanceId !== safeEvidence.candidateInstanceId || authorization.issuerInstanceId !== safeEvidence.issuerInstanceId || authorization.authorityEpoch !== safeEvidence.authorityEpoch || authorization.stateRevision !== safeEvidence.stateRevision || authorization.stateDigest !== safeEvidence.stateDigest) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = "authorization_invalid";
      metric("authority_recovery_decisions_total", { reason: "authorization_invalid" });
      event("authority.recovery.authorization.rejected", "warning", { classification: "authorization_invalid", state: "rejected", epoch: safeEvidence.authorityEpoch });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: "authorization_invalid", requiresOperatorAuthorization: false, authorized: false };
    }
    if (authorization.operatorIdentity === options.candidateInstanceId) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = "authorization_invalid";
      metric("authority_recovery_decisions_total", { reason: "authorization_invalid" });
      event("authority.recovery.authorization.rejected", "warning", { classification: "authorization_invalid", state: "rejected", epoch: safeEvidence.authorityEpoch });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: "authorization_invalid", requiresOperatorAuthorization: false, authorized: false };
    }
    const nowMs = now();
    if (authorization.issuedAt > nowMs + 30_000 || authorization.expiresAt < nowMs || authorization.expiresAt - authorization.issuedAt > MAX_AUTHORIZATION_LIFETIME_MS) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = "authorization_expired";
      metric("authority_recovery_decisions_total", { reason: "authorization_expired" });
      event("authority.recovery.authorization.rejected", "warning", { classification: "authorization_expired", state: "rejected", epoch: safeEvidence.authorityEpoch });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: "authorization_expired", requiresOperatorAuthorization: false, authorized: false };
    }
    if (revoked.has(authorization.authorizationId)) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = "authorization_revoked";
      metric("authority_recovery_decisions_total", { reason: "authorization_revoked" });
      event("authority.recovery.authorization.revoked", "warning", { classification: "authorization_revoked", state: "rejected", epoch: safeEvidence.authorityEpoch });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: "authorization_revoked", requiresOperatorAuthorization: false, authorized: false };
    }
    const publicKey = options.issuerIdentity.publicKey;
    const payload = signingPayload({
      version: authorization.version,
      authorizationId: authorization.authorizationId,
      candidateInstanceId: authorization.candidateInstanceId,
      authorityEpoch: authorization.authorityEpoch,
      stateRevision: authorization.stateRevision,
      stateDigest: authorization.stateDigest,
      issuerInstanceId: authorization.issuerInstanceId,
      operatorIdentity: authorization.operatorIdentity,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
      nonce: authorization.nonce ?? "",
    } as Omit<RecoveryOperatorAuthorization, "signature">);
    if (!verifyMessage(publicKey, payload, Buffer.from(authorization.signature, "base64"))) {
      _lastDecision = "denied"; _lastState = "rejected"; _lastReason = "authorization_invalid";
      metric("authority_recovery_decisions_total", { reason: "authorization_invalid" });
      event("authority.recovery.authorization.rejected", "warning", { classification: "authorization_invalid", state: "rejected", epoch: safeEvidence.authorityEpoch });
      recordCondition(_lastState);
      return { decision: "denied", state: "rejected", reason: "authorization_invalid", requiresOperatorAuthorization: false, authorized: false };
    }
    _lastDecision = "allowed"; _lastState = "authorized"; _lastReason = "authorization_accepted";
    metric("authority_recovery_accepted_total");
    event("authority.recovery.authorization.accepted", "info", { classification: "authorization_accepted", state: "authorized", epoch: safeEvidence.authorityEpoch });
    recordCondition(_lastState);
    return { decision: "allowed", state: "authorized", reason: "authorization_accepted", requiresOperatorAuthorization: false, authorized: true };
  };

  const service: AuthorityRecoveryPolicy = {
    evaluateRecovery: (evidence, authorization) => evaluate(evidence, authorization),
    async requestAuthorization(request) {
      if (!request || request.version !== 1 || !request.operatorIdentity || !ID.test(request.operatorIdentity) || !CANDIDATE.test(request.candidateInstanceId) || !CANDIDATE.test(request.issuerInstanceId) ||
        !Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 0 || !Number.isSafeInteger(request.stateRevision) || request.stateRevision < 0 || !DIGEST.test(request.stateDigest) ||
        !Number.isSafeInteger(request.issuedAt) || request.issuedAt <= 0 || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= request.issuedAt || request.expiresAt - request.issuedAt > MAX_AUTHORIZATION_LIFETIME_MS ||
        request.candidateInstanceId !== options.candidateInstanceId || request.issuerInstanceId !== options.issuerInstanceId) {
        throw new Error("recovery authorization request is invalid");
      }
      if (request.operatorIdentity === options.candidateInstanceId) throw new Error("candidate cannot authorize itself");
      const authorizationId = request.nonce ? `recovery-${request.nonce}` : `recovery-${request.candidateInstanceId}-${request.operatorIdentity}-${request.authorityEpoch}-${request.stateRevision}-${request.issuedAt}-${request.expiresAt}`;
      if (!NONCE.test(authorizationId)) throw new Error("recovery authorization identifier is invalid");
      const authorization: RecoveryOperatorAuthorization = {
        ...request,
        authorizationId,
        signature: signMessage(options.issuerIdentity.privateKey, Buffer.from(`OPENSTORE-AUTHORITY-RECOVERY-V1\n${canonical({
          version: request.version,
          authorizationId,
          candidateInstanceId: request.candidateInstanceId,
          authorityEpoch: request.authorityEpoch,
          stateRevision: request.stateRevision,
          stateDigest: request.stateDigest,
          issuerInstanceId: request.issuerInstanceId,
          operatorIdentity: request.operatorIdentity,
          issuedAt: request.issuedAt,
          expiresAt: request.expiresAt,
          nonce: request.nonce ?? "",
        })}`, "utf8")).toString("base64"),
      };
      if (authorizations.has(authorizationId)) throw new Error("recovery authorization is already known");
      authorizations.set(authorizationId, Object.freeze({ ...authorization }));
      if (options.persistencePath) { try { persist(); } catch { throw new Error("recovery authorization persistence is unavailable"); } }
      _lastAction = "request"; metric("authority_recovery_authorizations_total");
      event("authority.recovery.authorization.requested", "info", { classification: "authorization_requested", state: "authorization-required", epoch: request.authorityEpoch });
      return authorization;
    },
    approveRecovery(evidence, authorization) {
      const result = evaluate(evidence, authorization);
      if (result.decision !== "allowed") {
        if (result.reason === "authorization_expired") throw new Error("recovery authorization expired or invalid");
        if (result.reason === "authorization_revoked") throw new Error("recovery authorization revoked or invalid");
        throw new Error("recovery authorization is invalid or mismatched");
      }
      _lastAction = "approve"; metric("authority_recovery_approvals_total");
      event("authority.recovery.action.executed", "info", { classification: "recovery_approved", state: "recovered", epoch: evidence.authorityEpoch });
      return { ...result, state: "recovered", reason: "authorization_accepted" };
    },
    async rejectAuthorization(authorizationId, reason) {
      if (!ID.test(authorizationId) || !reason || reason.length > 256) throw new Error("recovery authorization rejection is invalid");
      if (!authorizations.has(authorizationId)) return;
      revoked.add(authorizationId);
      if (options.persistencePath) { try { persist(); } catch { throw new Error("recovery authorization revocation persistence is unavailable"); } }
      _lastAction = `reject:${authorizationId}`; metric("authority_recovery_rejections_total");
      event("authority.recovery.authorization.revoked", "warning", { classification: "authorization_revoked", state: "rejected", reason: "revocation" });
    },
    executeExplicitRecoveryAction(action, evidence, authorization) {
      if (action === "inspect") {
        _lastAction = "inspect";
        return evaluate(evidence, authorization);
      }
      if (action === "reset") {
        _lastAction = "reset";
        metric("authority_recovery_resets_total");
        event("authority.recovery.action.executed", "info", { classification: "recovery_reset", state: "rejected" });
        return { decision: "denied", state: "rejected", reason: "validation_failure", requiresOperatorAuthorization: false, authorized: false };
      }
      if (action === "fence") {
        _lastAction = "fence";
        metric("authority_recovery_fences_total");
        event("authority.recovery.action.executed", "info", { classification: "recovery_fence", state: "conflicted" });
        return { decision: "blocked", state: "conflicted", reason: "ownership_conflict", requiresOperatorAuthorization: false, authorized: false };
      }
      const result = evaluate(evidence, authorization);
      if (result.decision !== "allowed") {
        if (result.reason === "authorization_expired") throw new Error("recovery authorization expired or invalid");
        if (result.reason === "authorization_revoked") throw new Error("recovery authorization revoked or invalid");
        throw new Error("recovery authorization is invalid or mismatched");
      }
      _lastAction = "approve"; metric("authority_recovery_approvals_total");
      event("authority.recovery.action.executed", "info", { classification: "recovery_approved", state: "recovered", epoch: evidence.authorityEpoch });
      return { ...result, state: "recovered", reason: "authorization_accepted" };
    },
    inspect() {
      return Object.freeze({
        lastDecision: _lastDecision,
        lastState: _lastState,
        lastReason: _lastReason,
        persistedStateHealthy: persistenceHealthy,
        persistenceState,
        authorizations: Object.freeze([...authorizations.values()].map((authorization) => ({ ...authorization }))),
        revokedAuthorizationIds: Object.freeze([...revoked]),
        lastAction: _lastAction,
      });
    },
  };

  load();
  return service;
}
