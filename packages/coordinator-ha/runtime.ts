import type { AuthorityControlPlane } from "./authority-control-plane.js";
import type { createAuthorityGrantService } from "./authority-grant.js";
import type { AuthorityIssuerService } from "./authority-issuer.js";
import type { AuthorityOwnershipService, AuthorityOwnershipToken } from "./authority-ownership.js";
import type { EventStore, OperationalEventType } from "../events/index.js";
import type { MetricsRegistry } from "../metrics/index.js";
import type { Condition, ConditionEvaluator } from "../conditions/index.js";
import { evaluateAuthorityState, type AuthorityEligibility } from "./authority-contract.js";
import type { AuthorityRecoveryEvidence, AuthorityRecoveryPolicy, RecoveryOperatorAuthorization } from "./authority-recovery-policy.js";
import { createAuthorityRecoveryDrill } from "./authority-recovery-drill.js";

export type CoordinatorAuthorityRuntimeState = "stopped" | "running" | "degraded";
export type AuthorityRuntimeFailureCode =
  | "missing_issuer" | "uninitialized_issuer" | "corrupt_issuer" | "corrupt_candidate"
  | "corrupt_ownership" | "epoch_mismatch" | "issuer_identity_mismatch"
  | "ownership_conflict" | "validation_failure";

export interface CoordinatorAuthorityRuntimeStatus {
  readonly state: CoordinatorAuthorityRuntimeState;
  readonly authority: AuthorityEligibility;
  readonly issuerInstanceId: string;
  readonly issuerPersistenceHealthy: boolean;
  readonly candidatePersistenceHealthy: boolean;
  readonly ownershipPersistenceHealthy: boolean;
  readonly candidateState: ReturnType<ReturnType<typeof createAuthorityGrantService>["inspectState"]>;
  readonly ownership: ReturnType<AuthorityOwnershipService["inspectOwnership"]>;
  readonly failureCode?: AuthorityRuntimeFailureCode;
  readonly conditions: readonly Condition[];
  readonly lastTransition: "none" | "started" | "stopped" | "accepted" | "released" | "fenced" | "failed";
}

export interface CoordinatorAuthorityRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): CoordinatorAuthorityRuntimeStatus;
  validateOwnershipToken(token: AuthorityOwnershipToken): boolean;
  establishOwnership(): Promise<void>;
  releaseOwnership(reason: string): Promise<void>;
  fenceOwner(reason: string): Promise<void>;
  inspectRecovery(evidence?: AuthorityRecoveryEvidence): ReturnType<AuthorityRecoveryPolicy["evaluateRecovery"]>;
  inspectRecoveryDrill(evidence?: AuthorityRecoveryEvidence): ReturnType<ReturnType<typeof createAuthorityRecoveryDrill>["inspect"]>;
  diagnoseRecoveryDrill(evidence?: AuthorityRecoveryEvidence): ReturnType<ReturnType<typeof createAuthorityRecoveryDrill>["diagnose"]>;
}

export interface CoordinatorAuthorityRuntimeOptions {
  readonly controlPlane: AuthorityControlPlane;
  readonly issuer: AuthorityIssuerService;
  readonly ownership: AuthorityOwnershipService;
  readonly issuerInstanceId: string;
  readonly candidate: ReturnType<typeof createAuthorityGrantService>;
  readonly recoveryPolicy?: AuthorityRecoveryPolicy;
  readonly events?: EventStore;
  readonly metrics?: MetricsRegistry;
  readonly conditions?: ConditionEvaluator;
  readonly now?: () => number;
}

export function createCoordinatorAuthorityRuntime(options: CoordinatorAuthorityRuntimeOptions): CoordinatorAuthorityRuntime {
  let lifecycle: CoordinatorAuthorityRuntimeState = "stopped";
  let lastTransition: CoordinatorAuthorityRuntimeStatus["lastTransition"] = "none";
  let failureCode: AuthorityRuntimeFailureCode | undefined;
  const now = options.now ?? (() => Date.now());
  const metric = (name: string): void => { try { options.metrics?.increment(name); } catch { /* observability cannot alter safety */ } };
  const event = (type: OperationalEventType, severity: "info" | "warning" | "error", details: Record<string, string | number | boolean> = {}): void => {
    try { options.events?.append({ version: 1, timestamp: now(), component: "coordinator", type, severity, details }); } catch { /* observability cannot alter safety */ }
  };
  const classify = (message?: string): AuthorityRuntimeFailureCode => {
    if (message?.includes("revoked")) return "validation_failure";
    if (message?.includes("conflict")) return "ownership_conflict";
    if (message?.includes("issuer identity")) return "issuer_identity_mismatch";
    if (message?.includes("epoch")) return "epoch_mismatch";
    return "validation_failure";
  };

  const status = (): CoordinatorAuthorityRuntimeStatus => {
    const issuer = options.issuer.inspect();
    const candidateState = options.candidate.inspectState();
    const ownership = options.ownership.inspectOwnership();
    const candidatePersistenceHealthy = options.candidate.persistenceHealthy();
    const ownershipPersistenceHealthy = options.ownership.persistenceHealthy();
    const consistent = isConsistent(issuer, candidateState, ownership, candidatePersistenceHealthy, ownershipPersistenceHealthy, options.issuerInstanceId);
    const authority = evaluateAuthorityState(issuer.initialized && consistent && candidateState.state === "authoritative" && ownership.state === "authoritative" ? "authoritative" : "unknown");
    const conditions = options.conditions?.evaluate({
      authority: {
        lifecycle,
        authoritative: authority.placementAuthorized,
        persistenceHealthy: issuer.persistenceHealthy && candidatePersistenceHealthy && ownershipPersistenceHealthy,
        persistenceCorrupt: issuer.persistenceState === "corrupt" || options.candidate.persistenceState() === "corrupt" || options.ownership.persistenceState() === "corrupt",
        ownershipConflict: ownership.conflict || failureCode === "ownership_conflict",
        fenced: ownership.state === "fenced",
      },
    }, now()) ?? [];
    return Object.freeze({
      state: lifecycle === "running" && !consistent ? "degraded" : lifecycle,
      authority,
      issuerInstanceId: options.issuerInstanceId,
      issuerPersistenceHealthy: issuer.persistenceHealthy,
      candidatePersistenceHealthy,
      ownershipPersistenceHealthy,
      candidateState,
      ownership,
      failureCode,
      conditions,
      lastTransition,
    });
  };

  const recoveryPolicy = options.recoveryPolicy;
  const recoveryDrill = createAuthorityRecoveryDrill({
    policy: recoveryPolicy,
    runtime: undefined,
    controlPlane: undefined,
    now,
    events: options.events,
    metrics: options.metrics,
    conditions: options.conditions,
  });
  const checkRecoveryPolicy = (evidence?: AuthorityRecoveryEvidence): ReturnType<AuthorityRecoveryPolicy["evaluateRecovery"]> | undefined => {
    if (!recoveryPolicy) return undefined;
    return recoveryPolicy.evaluateRecovery(evidence, undefined);
  };

  return {
    async start() {
      if (lifecycle === "running") return;
      const current = status();
      const issuer = options.issuer.inspect();
      const candidateState = options.candidate.inspectState();
      const ownership = options.ownership.inspectOwnership();
      if (issuer.persistenceState === "corrupt") {
        failureCode = "corrupt_issuer"; lifecycle = "degraded"; lastTransition = "failed"; metric("authority_runtime_start_failures_total"); metric("authority_persistence_corrupt_total"); event("authority.startup.blocked", "error", { classification: failureCode }); throw new Error("authority runtime persistence is corrupt and invalid");
      }
      if (options.candidate.persistenceState() === "corrupt") {
        failureCode = "corrupt_candidate"; lifecycle = "degraded"; lastTransition = "failed"; metric("authority_runtime_start_failures_total"); metric("authority_persistence_corrupt_total"); event("authority.startup.blocked", "error", { classification: failureCode }); throw new Error("authority candidate persistence is corrupt and invalid");
      }
      if (options.ownership.persistenceState() === "corrupt") {
        failureCode = "corrupt_ownership"; lifecycle = "degraded"; lastTransition = "failed"; metric("authority_runtime_start_failures_total"); metric("authority_persistence_corrupt_total"); event("authority.startup.blocked", "error", { classification: failureCode }); throw new Error("authority ownership persistence is corrupt and invalid");
      }
      if (!issuer.initialized) {
        failureCode = issuer.persistenceState === "missing" ? "missing_issuer" : "uninitialized_issuer";
        lifecycle = "running"; lastTransition = "started"; metric("authority_runtime_starts_total"); metric("authority_runtime_non_authoritative_total"); metric("authority_persistence_degraded_total"); event("authority.startup.blocked", "warning", { classification: failureCode });
        if (recoveryPolicy) {
          const result = checkRecoveryPolicy();
          if (result && result.state === "authorization-required") {
            metric("authority_recovery_blocked_total");
            event("authority.recovery.blocked", "warning", { classification: "missing_evidence" });
          }
        }
        return;
      }
      if (!current.issuerPersistenceHealthy || !current.candidatePersistenceHealthy || !current.ownershipPersistenceHealthy ||
        (current.issuerPersistenceHealthy && options.issuer.inspect().initialized &&
          !isConsistent(options.issuer.inspect(), current.candidateState, current.ownership,
            current.candidatePersistenceHealthy, current.ownershipPersistenceHealthy, options.issuerInstanceId))) {
        failureCode = issuer.issuerInstanceId !== options.issuerInstanceId ? "issuer_identity_mismatch" :
          (candidateState.authorityEpoch !== issuer.authorityEpoch || ownership.authorityEpoch !== issuer.authorityEpoch) ? "epoch_mismatch" :
          ownership.conflict ? "ownership_conflict" : "validation_failure";
        lifecycle = "degraded";
        lastTransition = "failed";
        metric("authority_runtime_start_failures_total");
        event("authority.startup.blocked", "error", { classification: failureCode });
        throw new Error("authority runtime persistence or state is invalid");
      }
      lifecycle = "running";
      lastTransition = "started";
      failureCode = undefined;
      metric("authority_runtime_starts_total");
      event("authority.runtime.started", "info");
      if (candidateState.state === "authoritative") { metric("authority_runtime_restored_total"); event("authority.state.restored", "info", { epoch: issuer.authorityEpoch }); }
      if (ownership.state === "authoritative") { event("authority.ownership.restored", "info", { epoch: ownership.authorityEpoch }); }
      if (recoveryPolicy) {
        const result = checkRecoveryPolicy({
          version: 1,
          issuerInstanceId: options.issuerInstanceId,
          issuerInitialized: issuer.initialized,
          issuerPersistenceState: issuer.persistenceState,
          candidateInstanceId: candidateState.instanceId,
          authorityEpoch: issuer.authorityEpoch,
          candidateEpoch: candidateState.authorityEpoch,
          candidateState: candidateState.state,
          ownershipState: ownership.state,
          ownershipEpoch: ownership.authorityEpoch,
          ownerInstanceId: ownership.ownerInstanceId,
          stateRevision: candidateState.stateRevision ?? 0,
          stateDigest: candidateState.stateDigest ?? "0".repeat(64),
          stateFresh: true,
          validGrant: candidateState.state === "authoritative" || ownership.state === "authoritative",
          grantRevoked: false,
          issuerIdentityMatches: issuer.issuerInstanceId === options.issuerInstanceId,
          persistedStateHealthy: current.issuerPersistenceHealthy && current.candidatePersistenceHealthy && current.ownershipPersistenceHealthy,
          activeOwnershipConflict: ownership.conflict,
        });
        if (result && result.decision === "requires_operator_authorization") {
          metric("authority_recovery_blocked_total");
          event("authority.recovery.blocked", "warning", { classification: "authorization_required", state: "authorization-required" });
        }
      }
    },
    async stop() {
      if (lifecycle === "stopped") return;
      lifecycle = "stopped";
      lastTransition = "stopped";
      metric("authority_runtime_stops_total");
      event("authority.runtime.stopped", "info");
    },
    status,
    validateOwnershipToken: (token) => {
      const valid = options.ownership.validateOwnershipToken(token);
      if (!valid) { metric("authority_token_validation_failures_total"); event("authority.token.rejected", "warning", { classification: "validation_failure" }); }
      return valid;
    },
    async establishOwnership() {
      if (lifecycle !== "running") throw new Error("authority runtime is not running");
      try {
        await options.controlPlane.establishOwnership();
        lastTransition = "accepted"; metric("authority_ownership_establish_success_total"); event("authority.ownership.established", "info");
      } catch (error) {
        failureCode = classify(error instanceof Error ? error.message : undefined);
        metric("authority_ownership_establish_failures_total");
        if (failureCode === "validation_failure" && error instanceof Error && error.message.includes("revoked")) { metric("authority_revoked_grant_rejections_total"); event("authority.grant.revoked", "warning", { classification: "revoked_grant" }); }
        else event("authority.ownership.failed", "warning", { classification: failureCode });
        throw error;
      }
    },
    async releaseOwnership(reason) {
      if (lifecycle !== "running") throw new Error("authority runtime is not running");
      await options.controlPlane.releaseOwnership(reason);
      lastTransition = "released";
      metric("authority_ownership_releases_total"); event("authority.ownership.released", "info");
    },
    async fenceOwner(reason) {
      if (lifecycle !== "running") throw new Error("authority runtime is not running");
      await options.controlPlane.fenceOwner(reason);
      lastTransition = "fenced";
      metric("authority_owner_fencing_total"); event("authority.owner.fenced", "warning");
    },
    inspectRecovery(evidence) {
      return recoveryPolicy ? recoveryPolicy.evaluateRecovery(evidence, undefined) : { decision: "denied", state: "missing-evidence", reason: "missing_evidence", requiresOperatorAuthorization: false, authorized: false };
    },
    inspectRecoveryDrill(evidence) {
      return recoveryDrill.inspect(evidence);
    },
    diagnoseRecoveryDrill(evidence) {
      return recoveryDrill.diagnose(evidence);
    },
  };
}

function isConsistent(
  issuer: ReturnType<AuthorityIssuerService["inspect"]>,
  candidate: ReturnType<ReturnType<typeof createAuthorityGrantService>["inspectState"]>,
  ownership: ReturnType<AuthorityOwnershipService["inspectOwnership"]>,
  candidateHealthy: boolean,
  ownershipHealthy: boolean,
  expectedIssuerInstanceId: string,
): boolean {
  if (!issuer.persistenceHealthy || !candidateHealthy || !ownershipHealthy || !issuer.initialized ||
    issuer.issuerInstanceId !== expectedIssuerInstanceId) return false;
  if (candidate.state !== "non-authoritative" && candidate.authorityEpoch !== issuer.authorityEpoch) return false;
  if (ownership.state !== "non-authoritative" &&
    (ownership.authorityEpoch !== issuer.authorityEpoch || ownership.issuerInstanceId !== issuer.issuerInstanceId)) return false;
  if (ownership.conflict || (ownership.state === "authoritative" && candidate.state !== "authoritative")) return false;
  return true;
}
