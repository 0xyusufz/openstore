import type { AuthorityControlPlane } from "./authority-control-plane.js";
import type { createAuthorityGrantService } from "./authority-grant.js";
import type { AuthorityIssuerService } from "./authority-issuer.js";
import type { AuthorityOwnershipService, AuthorityOwnershipToken } from "./authority-ownership.js";
import { evaluateAuthorityState, type AuthorityEligibility } from "./authority-contract.js";

export type CoordinatorAuthorityRuntimeState = "stopped" | "running" | "degraded";

export interface CoordinatorAuthorityRuntimeStatus {
  readonly state: CoordinatorAuthorityRuntimeState;
  readonly authority: AuthorityEligibility;
  readonly issuerInstanceId: string;
  readonly issuerPersistenceHealthy: boolean;
  readonly candidatePersistenceHealthy: boolean;
  readonly ownershipPersistenceHealthy: boolean;
  readonly candidateState: ReturnType<ReturnType<typeof createAuthorityGrantService>["inspectState"]>;
  readonly ownership: ReturnType<AuthorityOwnershipService["inspectOwnership"]>;
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
}

export interface CoordinatorAuthorityRuntimeOptions {
  readonly controlPlane: AuthorityControlPlane;
  readonly issuer: AuthorityIssuerService;
  readonly ownership: AuthorityOwnershipService;
  readonly issuerInstanceId: string;
  readonly candidate: ReturnType<typeof createAuthorityGrantService>;
}

export function createCoordinatorAuthorityRuntime(options: CoordinatorAuthorityRuntimeOptions): CoordinatorAuthorityRuntime {
  let lifecycle: CoordinatorAuthorityRuntimeState = "stopped";
  let lastTransition: CoordinatorAuthorityRuntimeStatus["lastTransition"] = "none";

  const status = (): CoordinatorAuthorityRuntimeStatus => {
    const issuer = options.issuer.inspect();
    const candidateState = options.candidate.inspectState();
    const ownership = options.ownership.inspectOwnership();
    const candidatePersistenceHealthy = options.candidate.persistenceHealthy();
    const ownershipPersistenceHealthy = options.ownership.persistenceHealthy();
    const consistent = isConsistent(issuer, candidateState, ownership, candidatePersistenceHealthy, ownershipPersistenceHealthy, options.issuerInstanceId);
    return Object.freeze({
      state: lifecycle === "running" && !consistent ? "degraded" : lifecycle,
      authority: evaluateAuthorityState(issuer.initialized && consistent && candidateState.state === "authoritative" && ownership.state === "authoritative" ? "authoritative" : "unknown"),
      issuerInstanceId: options.issuerInstanceId,
      issuerPersistenceHealthy: issuer.persistenceHealthy,
      candidatePersistenceHealthy,
      ownershipPersistenceHealthy,
      candidateState,
      ownership,
      lastTransition,
    });
  };

  return {
    async start() {
      if (lifecycle === "running") return;
      const current = status();
      if (!current.issuerPersistenceHealthy || !current.candidatePersistenceHealthy || !current.ownershipPersistenceHealthy ||
        (current.issuerPersistenceHealthy && options.issuer.inspect().initialized &&
          !isConsistent(options.issuer.inspect(), current.candidateState, current.ownership,
            current.candidatePersistenceHealthy, current.ownershipPersistenceHealthy, options.issuerInstanceId))) {
        lifecycle = "degraded";
        lastTransition = "failed";
        throw new Error("authority runtime persistence or state is invalid");
      }
      lifecycle = "running";
      lastTransition = "started";
    },
    async stop() {
      if (lifecycle === "stopped") return;
      lifecycle = "stopped";
      lastTransition = "stopped";
    },
    status,
    validateOwnershipToken: (token) => options.ownership.validateOwnershipToken(token),
    async establishOwnership() {
      if (lifecycle !== "running") throw new Error("authority runtime is not running");
      await options.controlPlane.establishOwnership();
      lastTransition = "accepted";
    },
    async releaseOwnership(reason) {
      if (lifecycle !== "running") throw new Error("authority runtime is not running");
      await options.controlPlane.releaseOwnership(reason);
      lastTransition = "released";
    },
    async fenceOwner(reason) {
      if (lifecycle !== "running") throw new Error("authority runtime is not running");
      await options.controlPlane.fenceOwner(reason);
      lastTransition = "fenced";
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
  if (ownership.state === "authoritative" && candidate.state !== "authoritative") return false;
  return true;
}
