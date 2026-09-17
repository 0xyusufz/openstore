import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore } from "../events/index.js";
import type { ConditionEvaluator } from "../conditions/index.js";
import type { MetricsRegistry } from "../metrics/index.js";
import type { AuthorityControlPlane } from "./authority-control-plane.js";
import type { AuthorityRecoveryDecision, AuthorityRecoveryEvidence, AuthorityRecoveryPolicy, AuthorityRecoveryReason, AuthorityRecoveryState, RecoveryOperatorAuthorization } from "./authority-recovery-policy.js";
import type { CoordinatorAuthorityRuntime } from "./runtime.js";

export type RecoveryDrillState =
  | "idle"
  | "degraded"
  | "diagnosed"
  | "authorization-required"
  | "authorized"
  | "executing"
  | "recovered"
  | "verification-failed"
  | "interrupted"
  | "aborted"
  | "rejected";

export type RecoveryDrillReason =
  | "healthy"
  | "missing_evidence"
  | "stale_evidence"
  | "authorization_required"
  | "authorization_invalid"
  | "authorization_expired"
  | "authorization_revoked"
  | "replay_detected"
  | "ownership_conflict"
  | "validation_failure"
  | "corrupt_persistence"
  | "execution_failed"
  | "verification_failed"
  | "manual_reject"
  | "interrupted"
  | "aborted"
  | "executed";

export interface RecoveryDrillResult {
  readonly state: RecoveryDrillState;
  readonly reason: RecoveryDrillReason;
  readonly decision: AuthorityRecoveryDecision;
  readonly recoveryState: AuthorityRecoveryState;
  readonly recoveryReason: AuthorityRecoveryReason;
  readonly authorizationRequired: boolean;
  readonly authorized: boolean;
  readonly executed: boolean;
  readonly verified: boolean;
}

export interface RecoveryDiagnosticSnapshot {
  readonly version: 1;
  readonly state: RecoveryDrillState;
  readonly reason: RecoveryDrillReason;
  readonly decision: AuthorityRecoveryDecision;
  readonly recoveryState: AuthorityRecoveryState;
  readonly recoveryReason: AuthorityRecoveryReason;
  readonly candidateInstanceId?: string;
  readonly issuerInstanceId?: string;
  readonly authorityEpoch?: number;
  readonly stateRevision?: number;
  readonly stateDigest?: string;
  readonly observedAt: number;
  readonly persistenceState: "missing" | "valid" | "corrupt";
  readonly persisted: boolean;
  readonly ownershipState?: string;
  readonly ownershipConflict: boolean;
  readonly authorizationRequired: boolean;
  readonly authorizationId?: string;
  readonly lastTransition?: string;
}

export interface RecoveryDrillRecord {
  readonly version: 1;
  readonly state: RecoveryDrillState;
  readonly reason: RecoveryDrillReason;
  readonly decision: AuthorityRecoveryDecision;
  readonly recoveryState: AuthorityRecoveryState;
  readonly recoveryReason: AuthorityRecoveryReason;
  readonly candidateInstanceId?: string;
  readonly issuerInstanceId?: string;
  readonly authorityEpoch?: number;
  readonly stateRevision?: number;
  readonly stateDigest?: string;
  readonly authorizationId?: string;
  readonly observedAt: number;
  readonly updatedAt: number;
}

export interface AuthorityRecoveryDrill {
  inspect(evidence?: AuthorityRecoveryEvidence): RecoveryDrillResult;
  diagnose(evidence?: AuthorityRecoveryEvidence): RecoveryDiagnosticSnapshot;
  prepare(evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult;
  execute(action: "inspect" | "approve" | "reset" | "fence", evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult;
  verify(evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult;
  read(): RecoveryDrillRecord | undefined;
}

export interface AuthorityRecoveryDrillOptions {
  readonly runtime?: CoordinatorAuthorityRuntime;
  readonly controlPlane?: AuthorityControlPlane;
  readonly policy?: AuthorityRecoveryPolicy;
  readonly persistencePath?: string;
  readonly events?: EventStore;
  readonly metrics?: MetricsRegistry;
  readonly conditions?: ConditionEvaluator;
  readonly now?: () => number;
}

const VALID_DRILL_STATES: readonly RecoveryDrillState[] = [
  "idle",
  "degraded",
  "diagnosed",
  "authorization-required",
  "authorized",
  "executing",
  "recovered",
  "verification-failed",
  "interrupted",
  "aborted",
  "rejected",
];

function legalTransition(from: RecoveryDrillState, to: RecoveryDrillState): boolean {
  const transitions: Record<RecoveryDrillState, readonly RecoveryDrillState[]> = {
    idle: ["degraded", "diagnosed", "authorization-required", "rejected"],
    degraded: ["diagnosed", "authorization-required", "rejected"],
    diagnosed: ["authorization-required", "authorized", "rejected", "degraded"],
    "authorization-required": ["authorized", "rejected", "interrupted", "degraded", "aborted"],
    authorized: ["executing", "rejected", "interrupted", "degraded", "aborted"],
    executing: ["recovered", "verification-failed", "interrupted", "rejected", "aborted", "degraded"],
    recovered: ["verification-failed", "rejected", "degraded"],
    "verification-failed": ["rejected", "degraded", "diagnosed"],
    interrupted: ["diagnosed", "authorization-required", "rejected", "degraded", "aborted"],
    aborted: ["rejected", "degraded", "diagnosed"],
    rejected: ["diagnosed", "authorization-required", "interrupted", "degraded"],
  };
  return transitions[from]?.includes(to) ?? false;
}

function toRecoveryDrillState(decision: AuthorityRecoveryDecision, state: AuthorityRecoveryState): RecoveryDrillState {
  if (decision === "requires_operator_authorization") return "authorization-required";
  if (decision === "allowed") return state === "recovered" ? "recovered" : "authorized";
  if (state === "conflicted" || state === "stale" || state === "unavailable") return "degraded";
  if (state === "rejected") return "rejected";
  return "degraded";
}

function toRecoveryDrillReason(reason: AuthorityRecoveryReason): RecoveryDrillReason {
  switch (reason) {
    case "authorization_required": return "authorization_required";
    case "authorization_expired": return "authorization_expired";
    case "authorization_revoked": return "authorization_revoked";
    case "authorization_invalid": return "authorization_invalid";
    case "stale_evidence": return "stale_evidence";
    case "ownership_conflict": return "ownership_conflict";
    case "missing_evidence": return "missing_evidence";
    case "corrupt_issuer":
    case "corrupt_candidate":
    case "corrupt_ownership":
      return "corrupt_persistence";
    case "authorization_accepted": return "executed";
    case "validation_failure":
    case "invalid_evidence":
    case "conflicted_evidence":
      return "validation_failure";
    default: return "healthy";
  }
}

export function createAuthorityRecoveryDrill(options: AuthorityRecoveryDrillOptions = {}): AuthorityRecoveryDrill {
  const now = options.now ?? (() => Date.now());
  const event = (type: string, severity: "info" | "warning" | "error", details: Record<string, string | number | boolean> = {}): void => {
    try { options.events?.append({ version: 1, timestamp: now(), component: "coordinator", type: type as never, severity, details }); } catch { /* observability cannot alter safety */ }
  };
  const metric = (name: string, labels: Record<string, string> = {}): void => {
    try { options.metrics?.increment(name, 1, labels); } catch { /* observability cannot alter safety */ }
  };

  let persisted: RecoveryDrillRecord | undefined;
  let persistenceState: "missing" | "valid" | "corrupt" = "missing";
  let persistedHealthy = true;

  const readPersisted = (): void => {
    if (!options.persistencePath) return;
    const exists = existsSync(options.persistencePath);
    if (!exists) {
      persistenceState = "missing";
      persistedHealthy = true;
      persisted = undefined;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(options.persistencePath, "utf8")) as RecoveryDrillRecord;
      if (!parsed || parsed.version !== 1 || !VALID_DRILL_STATES.includes(parsed.state)) throw new Error("invalid drill record");
      persisted = parsed;
      persistenceState = "valid";
      persistedHealthy = true;
    } catch {
      persistenceState = "corrupt";
      persistedHealthy = false;
      persisted = undefined;
    }
  };

  const persist = (record: RecoveryDrillRecord): void => {
    if (!options.persistencePath) return;
    try {
      mkdirSync(dirname(options.persistencePath), { recursive: true, mode: 0o700 });
      const temp = `${options.persistencePath}.tmp-${process.pid}-${Date.now()}`;
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
      chmodSync(temp, 0o600);
      renameSync(temp, options.persistencePath);
      const dirFd = openSync(dirname(options.persistencePath), "r");
      try { fsyncSync(dirFd); }
      finally { closeSync(dirFd); }
      persisted = record;
      persistenceState = "valid";
      persistedHealthy = true;
    } catch {
      persistenceState = "corrupt";
      persistedHealthy = false;
      throw new Error("recovery drill persistence is unavailable");
    }
  };

  const evaluate = (evidence?: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult => {
    const policy = options.policy;
    if (!policy) {
      const result: RecoveryDrillResult = {
        state: "degraded",
        reason: "missing_evidence",
        decision: "denied",
        recoveryState: "missing-evidence",
        recoveryReason: "missing_evidence",
        authorizationRequired: false,
        authorized: false,
        executed: false,
        verified: false,
      };
      event("authority.recovery.blocked", "warning", { state: result.state, reason: result.reason });
      return result;
    }
    const policyResult = policy.evaluateRecovery(evidence, authorization);
    const state = toRecoveryDrillState(policyResult.decision, policyResult.state);
    return {
      state,
      reason: toRecoveryDrillReason(policyResult.reason),
      decision: policyResult.decision,
      recoveryState: policyResult.state,
      recoveryReason: policyResult.reason,
      authorizationRequired: policyResult.requiresOperatorAuthorization,
      authorized: policyResult.authorized,
      executed: policyResult.decision === "allowed",
      verified: policyResult.decision === "allowed",
    };
  };

  const assertTransition = (from: RecoveryDrillState, to: RecoveryDrillState): void => {
    if (!legalTransition(from, to)) {
      throw new Error(`recovery drill transition is invalid: ${from} -> ${to}`);
    }
  };

  const snapshot = (evidence?: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDiagnosticSnapshot => {
    const result = evaluate(evidence, authorization);
    const runtimeStatus = options.runtime?.status();
    return Object.freeze({
      version: 1,
      state: result.state,
      reason: result.reason,
      decision: result.decision,
      recoveryState: result.recoveryState,
      recoveryReason: result.recoveryReason,
      candidateInstanceId: evidence?.candidateInstanceId ?? runtimeStatus?.candidateState.instanceId,
      issuerInstanceId: evidence?.issuerInstanceId ?? runtimeStatus?.issuerInstanceId,
      authorityEpoch: evidence?.authorityEpoch ?? runtimeStatus?.candidateState.authorityEpoch,
      stateRevision: evidence?.stateRevision ?? runtimeStatus?.candidateState.stateRevision,
      stateDigest: evidence?.stateDigest ?? runtimeStatus?.candidateState.stateDigest,
      observedAt: now(),
      persistenceState,
      persisted: persistedHealthy,
      ownershipState: evidence?.ownershipState ?? runtimeStatus?.ownership.state,
      ownershipConflict: evidence?.activeOwnershipConflict ?? runtimeStatus?.ownership.conflict ?? false,
      authorizationRequired: result.authorizationRequired,
      authorizationId: authorization?.authorizationId,
      lastTransition: result.state,
    });
  };

  const applyTransition = (current: RecoveryDrillState, next: RecoveryDrillState): RecoveryDrillState => {
    if (current !== "idle" && !legalTransition(current, next)) {
      throw new Error(`illegal recovery drill transition: ${current} -> ${next}`);
    }
    return next;
  };

  const record = (result: RecoveryDrillResult, evidence?: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillRecord => ({
    version: 1,
    state: result.state,
    reason: result.reason,
    decision: result.decision,
    recoveryState: result.recoveryState,
    recoveryReason: result.recoveryReason,
    candidateInstanceId: evidence?.candidateInstanceId,
    issuerInstanceId: evidence?.issuerInstanceId,
    authorityEpoch: evidence?.authorityEpoch,
    stateRevision: evidence?.stateRevision,
    stateDigest: evidence?.stateDigest,
    authorizationId: authorization?.authorizationId,
    observedAt: now(),
    updatedAt: now(),
  });

  const persistIfPossible = (state: RecoveryDrillState, reason: RecoveryDrillReason, result: RecoveryDrillResult, evidence?: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): void => {
    if (!options.persistencePath) return;
    const input = record({ ...result, state, reason }, evidence, authorization);
    try { persist(input); } catch { /* fail closed; no implicit recovery */ }
  };

  readPersisted();

  return {
    inspect(evidence) {
      const result = evaluate(evidence);
      if (result.decision === "requires_operator_authorization") {
        event("authority.recovery.authorization.requested", "info", { state: result.recoveryState, reason: result.recoveryReason });
      }
      return result;
    },
    diagnose(evidence) {
      const snap = snapshot(evidence);
      metric("authority_recovery_drill_diagnoses_total");
      event("authority.recovery.blocked", snap.state === "degraded" || snap.state === "rejected" ? "warning" : "info", { state: snap.state, reason: snap.reason, decision: snap.decision });
      if (options.conditions) {
        options.conditions.evaluate({ authority: { recoveryState: snap.state === "authorization-required" ? "authorization-required" : snap.state === "recovered" ? "recovered" : snap.state === "rejected" ? "rejected" : snap.state === "degraded" ? "conflicted" : "stale" } }, now());
      }
      return snap;
    },
    prepare(evidence, authorization) {
      const result = evaluate(evidence, authorization);
      if (result.decision === "requires_operator_authorization") {
        const next: RecoveryDrillResult = { ...result, state: "authorization-required", reason: "authorization_required" };
        const state = applyTransition("idle", "authorization-required");
        if (state !== "authorization-required") throw new Error("invalid drill state transition");
        persistIfPossible("authorization-required", "authorization_required", next, evidence, authorization);
        event("authority.recovery.authorization.requested", "warning", { state: "authorization-required", reason: "authorization_required" });
        return next;
      }
      if (result.decision === "denied" || result.decision === "blocked") {
        const next: RecoveryDrillResult = { ...result, state: "rejected", reason: result.reason === "authorization_revoked" ? "authorization_revoked" : result.reason === "authorization_expired" ? "authorization_expired" : result.reason === "authorization_invalid" ? "authorization_invalid" : "validation_failure", decision: "denied", recoveryState: "rejected", recoveryReason: result.recoveryReason, authorizationRequired: false, authorized: false, executed: false, verified: false };
        applyTransition("idle", "rejected");
        persistIfPossible("rejected", next.reason, next, evidence, authorization);
        event("authority.recovery.blocked", "error", { state: "rejected", reason: next.reason });
        return next;
      }
      const next: RecoveryDrillResult = { ...result, state: "authorized", reason: "executed", executed: true, verified: true };
      applyTransition("diagnosed", "authorized");
      persistIfPossible("authorized", "executed", next, evidence, authorization);
      event("authority.recovery.authorization.accepted", "info", { state: "authorized", epoch: evidence.authorityEpoch });
      return next;
    },
    execute(action, evidence, authorization) {
      if (action === "inspect") {
        const result = evaluate(evidence, authorization);
        applyTransition("idle", result.state === "authorization-required" ? "authorization-required" : "diagnosed");
        return result;
      }
      if (action === "reset") {
        const next: RecoveryDrillResult = {
          state: "aborted",
          reason: "aborted",
          decision: "denied",
          recoveryState: "rejected",
          recoveryReason: "validation_failure",
          authorizationRequired: false,
          authorized: false,
          executed: false,
          verified: false,
        };
        applyTransition("executing", "aborted");
        persistIfPossible("aborted", "aborted", next, evidence, authorization);
        event("authority.recovery.action.executed", "warning", { action: "reset", state: "aborted" });
        return next;
      }
      if (action === "fence") {
        const next: RecoveryDrillResult = {
          state: "degraded",
          reason: "ownership_conflict",
          decision: "blocked",
          recoveryState: "conflicted",
          recoveryReason: "ownership_conflict",
          authorizationRequired: false,
          authorized: false,
          executed: false,
          verified: false,
        };
        applyTransition("authorized", "degraded");
        persistIfPossible("degraded", "ownership_conflict", next, evidence, authorization);
        event("authority.recovery.blocked", "error", { action: "fence", state: "conflicted", reason: "ownership_conflict" });
        return next;
      }
      const policy = options.policy;
      if (!policy || !authorization) {
        const next: RecoveryDrillResult = {
          state: "authorization-required",
          reason: "authorization_required",
          decision: "requires_operator_authorization",
          recoveryState: "authorization-required",
          recoveryReason: "authorization_required",
          authorizationRequired: true,
          authorized: false,
          executed: false,
          verified: false,
        };
        applyTransition("authorized", "authorization-required");
        persistIfPossible("authorization-required", "authorization_required", next, evidence, authorization);
        return next;
      }
      let next: RecoveryDrillResult;
      try {
        applyTransition("authorized", "executing");
        const result = policy.approveRecovery(evidence, authorization);
        next = {
          state: result.state === "recovered" ? "recovered" : "authorized",
          reason: result.state === "recovered" ? "executed" : "healthy",
          decision: result.decision,
          recoveryState: result.state,
          recoveryReason: result.reason,
          authorizationRequired: false,
          authorized: result.authorized,
          executed: result.decision === "allowed",
          verified: result.decision === "allowed",
        };
        if (next.state === "recovered") {
          applyTransition("executing", "recovered");
        } else {
          applyTransition("executing", "authorized");
        }
      } catch {
        const result = evaluate(evidence, authorization);
        next = { ...result, state: "rejected", reason: result.reason === "authorization_revoked" ? "authorization_revoked" : result.reason === "authorization_expired" ? "authorization_expired" : result.reason === "authorization_invalid" ? "authorization_invalid" : "validation_failure", decision: "denied", recoveryState: "rejected", recoveryReason: "validation_failure", authorizationRequired: false, authorized: false, executed: false, verified: false };
        applyTransition("executing", "rejected");
      }
      persistIfPossible(next.state, next.reason, next, evidence, authorization);
      if (next.state === "recovered") {
        metric("authority_recovery_actions_total", { result: "success" });
        event("authority.recovery.action.executed", "info", { action: "approve", state: "recovered", epoch: evidence.authorityEpoch });
      } else {
        metric("authority_recovery_actions_total", { result: "rejected" });
        event("authority.recovery.action.executed", "warning", { action: "approve", state: next.state, reason: next.reason });
      }
      return next;
    },
    verify(evidence, authorization) {
      const evaluation = evaluate(evidence, authorization);
      const runtimeStatus = options.runtime?.status();
      const verified = evaluation.decision === "allowed" && !runtimeStatus?.ownership.conflict && (runtimeStatus?.authority.placementAuthorized === true || evidence.ownershipState === "authoritative");
      const next: RecoveryDrillResult = verified
        ? { ...evaluation, state: "recovered", reason: "executed", decision: "allowed", recoveryState: "recovered", recoveryReason: "authorization_accepted", authorizationRequired: false, authorized: true, executed: true, verified: true }
        : { ...evaluation, state: "verification-failed", reason: evaluation.reason === "authorization_expired" ? "authorization_expired" : evaluation.reason === "authorization_revoked" ? "authorization_revoked" : evaluation.reason === "authorization_invalid" ? "authorization_invalid" : "verification_failed", decision: "denied", recoveryState: "rejected", recoveryReason: "validation_failure", authorizationRequired: false, authorized: false, executed: false, verified: false };
      applyTransition("executing", verified ? "recovered" : "verification-failed");
      persistIfPossible(next.state, next.reason, next, evidence, authorization);
      if (verified) {
        metric("authority_recovery_verifications_total", { result: "success" });
        event("authority.recovery.action.executed", "info", { action: "verify", state: "recovered", epoch: evidence.authorityEpoch });
      } else {
        metric("authority_recovery_verifications_total", { result: "rejected" });
        event("authority.recovery.blocked", "warning", { action: "verify", state: "verification-failed", reason: next.reason });
      }
      return next;
    },
    read() {
      readPersisted();
      return persisted;
    },
  };
}
