import type { AuthorityGrantServiceOptions } from "./authority-grant.js";
import { createAuthorityGrantService, type SignedAuthorityGrant } from "./authority-grant.js";
import { type AuthorityIssuerService, type AuthorityIssuanceRequest } from "./authority-issuer.js";
import { evaluateAuthorityState, type AuthorityEligibility } from "./authority-contract.js";
import type { AuthorityOwnershipService, AuthorityOwnershipToken, AuthorityOwnershipRecord } from "./authority-ownership.js";
import { createAuthorityRecoveryPolicy, type AuthorityRecoveryEvidence, type AuthorityRecoveryPolicy, type AuthorityRecoveryPolicyEvaluation, type AuthorityRecoveryPolicyInspection, type RecoveryOperatorAuthorization, type RecoveryOperatorAuthorizationRequest } from "./authority-recovery-policy.js";
import { createAuthorityRecoveryDrill, type AuthorityRecoveryDrill, type RecoveryDrillResult } from "./authority-recovery-drill.js";

export interface AuthorityControlPlaneRequest extends AuthorityIssuanceRequest {
  readonly operation: "request-grant";
}

export type AuthorityRecoveryAuthorizationState = "none" | "requested" | "accepted" | "rejected" | "revoked";

export interface AuthorityControlPlaneInspection {
  readonly issuerInstanceId: string;
  readonly candidateInstanceId: string;
  readonly candidateState: ReturnType<ReturnType<typeof createAuthorityGrantService>["inspectState"]>;
  readonly eligibility: AuthorityEligibility;
  readonly deliveredGrantId?: string;
  readonly deliveredIssuerInstanceId?: string;
  readonly issuer: ReturnType<AuthorityIssuerService["inspect"]>;
  readonly audits: ReturnType<AuthorityIssuerService["audits"]>;
  readonly revokedGrantIds: readonly string[];
  readonly revocations: ReturnType<AuthorityIssuerService["revocations"]>;
  readonly lastTransition: "none" | "issued" | "delivered" | "accepted" | "revoked" | "failed";
  readonly ownership?: AuthorityOwnershipRecord;
  readonly recovery?: {
    readonly state: AuthorityRecoveryPolicyInspection["lastState"];
    readonly decision: AuthorityRecoveryPolicyInspection["lastDecision"];
    readonly reason: AuthorityRecoveryPolicyInspection["lastReason"];
    readonly authorizationState: AuthorityRecoveryAuthorizationState;
  };
};

export interface AuthorityControlPlane {
  requestGrant(request: AuthorityControlPlaneRequest): Promise<SignedAuthorityGrant>;
  issueGrant(request: AuthorityControlPlaneRequest): Promise<SignedAuthorityGrant>;
  deliverGrant(grant: SignedAuthorityGrant): Promise<void>;
  acceptGrant(grantId: string): Promise<void>;
  revokeGrant(grantId: string, callerIdentity: string): Promise<void>;
  inspectRevocation(grantId: string): ReturnType<AuthorityIssuerService["inspectRevocation"]>;
  inspectRecovery(evidence?: AuthorityRecoveryEvidence): AuthorityRecoveryPolicyEvaluation;
  requestRecoveryAuthorization(request: RecoveryOperatorAuthorizationRequest): Promise<RecoveryOperatorAuthorization>;
  approveRecovery(evidence: AuthorityRecoveryEvidence, authorization: RecoveryOperatorAuthorization): AuthorityRecoveryPolicyEvaluation;
  rejectRecoveryAuthorization(authorizationId: string, reason: string): Promise<void>;
  executeExplicitRecoveryAction(action: "inspect" | "approve" | "reset" | "fence", evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): AuthorityRecoveryPolicyEvaluation;
  inspectRecoveryDrill(evidence?: AuthorityRecoveryEvidence): RecoveryDrillResult;
  diagnoseRecoveryDrill(evidence?: AuthorityRecoveryEvidence): ReturnType<AuthorityRecoveryDrill["diagnose"]>;
  prepareRecoveryDrill(evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult;
  executeRecoveryDrill(action: "inspect" | "approve" | "reset" | "fence", evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult;
  verifyRecoveryDrill(evidence: AuthorityRecoveryEvidence, authorization?: RecoveryOperatorAuthorization): RecoveryDrillResult;
  establishOwnership(): Promise<void>;
  releaseOwnership(reason: string): Promise<void>;
  fenceOwner(reason: string): Promise<void>;
  inspect(): AuthorityControlPlaneInspection;
}

export interface AuthorityControlPlaneOptions {
  readonly issuer: AuthorityIssuerService;
  readonly candidate: ReturnType<typeof createAuthorityGrantService>;
  readonly candidateInstanceId: string;
  readonly issuerInstanceId: string;
  readonly revokedGrantIds?: () => readonly string[];
  readonly ownership?: AuthorityOwnershipService;
  readonly recoveryPolicy?: AuthorityRecoveryPolicy;
  readonly recoveryPolicyFactory?: (options: {
    readonly issuerIdentity: { publicKey: Buffer; privateKey: Buffer };
    readonly issuerInstanceId: string;
    readonly candidateInstanceId: string;
    readonly persistencePath?: string;
    readonly now?: () => number;
  }) => AuthorityRecoveryPolicy;
  readonly recoveryPersistencePath?: string;
  readonly issuerIdentity?: { publicKey: Buffer; privateKey: Buffer };
  readonly drillPersistencePath?: string;
  readonly now?: () => number;
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createAuthorityControlPlane(options: AuthorityControlPlaneOptions): AuthorityControlPlane {
  if (!INSTANCE_ID.test(options.candidateInstanceId) || !INSTANCE_ID.test(options.issuerInstanceId)) {
    throw new TypeError("control-plane instance identity is invalid");
  }
  const recoveryPolicy = options.recoveryPolicy ?? (
    options.issuerIdentity ? createAuthorityRecoveryPolicy({
      issuerIdentity: options.issuerIdentity,
      issuerInstanceId: options.issuerInstanceId,
      candidateInstanceId: options.candidateInstanceId,
      persistencePath: options.recoveryPersistencePath,
      now: options.now,
    }) : undefined
  );
  const recoveryDrill = createAuthorityRecoveryDrill({
    policy: recoveryPolicy,
    runtime: undefined,
    controlPlane: undefined,
    persistencePath: options.drillPersistencePath,
    now: options.now,
  });
  let delivered: SignedAuthorityGrant | undefined;
  let lastTransition: AuthorityControlPlaneInspection["lastTransition"] = "none";
  let recoveryAuthorizationState: AuthorityRecoveryAuthorizationState = "none";

  const validateRequest = (request: AuthorityControlPlaneRequest): void => {
    if (!request || request.operation !== "request-grant" || request.version !== 1 ||
      !request.callerIdentity ||
      request.candidateInstanceId !== options.candidateInstanceId) {
      if (request?.candidateInstanceId !== options.candidateInstanceId) throw new Error("authority control-plane candidate identity is invalid");
      throw new Error("authority control-plane request is invalid");
    }
    if (
      request.authorityEpoch < 0 || request.stateRevision < 0 || !request.stateDigest ||
      !request.grantId || !request.issuedAt || !request.expiresAt) {
      throw new Error("authority control-plane request is invalid");
    }
  };
  const issueGrant = async (request: AuthorityControlPlaneRequest): Promise<SignedAuthorityGrant> => {
    try {
      validateRequest(request);
      const grant = await options.issuer.issue(request);
      if (grant.candidateInstanceId !== options.candidateInstanceId || grant.issuerInstanceId !== options.issuerInstanceId) {
        throw new Error("authority grant identity binding is invalid");
      }
      delivered = undefined;
      lastTransition = "issued";
      return grant;
    } catch (error) {
      lastTransition = "failed";
      throw error;
    }
  };
  const deliverGrant = async (grant: SignedAuthorityGrant): Promise<void> => {
    if (!grant || grant.candidateInstanceId !== options.candidateInstanceId || grant.issuerInstanceId !== options.issuerInstanceId) {
      lastTransition = "failed";
      throw new Error("authority grant delivery identity is invalid");
    }
    delivered = grant;
    lastTransition = "delivered";
  };
  const recoveryInspection = (): AuthorityControlPlaneInspection["recovery"] => {
    if (!recoveryPolicy) return undefined as never;
    const result = recoveryPolicy.inspect();
    const authorizationState = result.authorizations.length > 0 ? "requested" : "none";
    return Object.freeze({
      state: result.lastState,
      decision: result.lastDecision,
      reason: result.lastReason,
      authorizationState,
    });
  };

  return {
    requestGrant: issueGrant,
    issueGrant,
    deliverGrant,
    async acceptGrant(grantId) {
      if (!GRANT_ID.test(grantId) || !delivered || delivered.grantId !== grantId) {
        lastTransition = "failed";
        throw new Error("authority grant was not delivered");
      }
      try {
        const issuerStatus = options.issuer.inspect();
        if (!issuerStatus.persistenceHealthy) throw new Error("revocation status is unavailable");
        if (options.issuer.inspectRevocation(delivered.grantId)) throw new Error("authority grant is revoked");
        await options.candidate.acceptGrant(delivered);
        lastTransition = "accepted";
      } catch (error) {
        lastTransition = "failed";
        throw error;
      }
    },
    async revokeGrant(grantId, callerIdentity) {
      if (!GRANT_ID.test(grantId)) throw new Error("authority grant ID is invalid");
      try {
        await options.issuer.revoke(grantId, callerIdentity);
        await options.candidate.revoke(`grant-revoked:${grantId}`);
        if (delivered?.grantId === grantId) delivered = undefined;
        lastTransition = "revoked";
      } catch (error) {
        lastTransition = "failed";
        throw error;
      }
    },
    inspectRecovery(evidence) {
      if (!recoveryPolicy) {
        return { decision: "denied", state: "missing-evidence", reason: "missing_evidence", requiresOperatorAuthorization: false, authorized: false };
      }
      const result = recoveryPolicy.evaluateRecovery(evidence, undefined);
      return result;
    },
    async requestRecoveryAuthorization(request) {
      if (!recoveryPolicy) throw new Error("recovery policy is unavailable");
      const authorization = await recoveryPolicy.requestAuthorization(request);
      recoveryAuthorizationState = "requested";
      return authorization;
    },
    approveRecovery(evidence, authorization) {
      if (!recoveryPolicy) throw new Error("recovery policy is unavailable");
      const result = recoveryPolicy.approveRecovery(evidence, authorization);
      recoveryAuthorizationState = result.authorized ? "accepted" : "rejected";
      return result;
    },
    async rejectRecoveryAuthorization(authorizationId, reason) {
      if (!recoveryPolicy) throw new Error("recovery policy is unavailable");
      await recoveryPolicy.rejectAuthorization(authorizationId, reason);
      recoveryAuthorizationState = "revoked";
    },
    executeExplicitRecoveryAction(action, evidence, authorization) {
      if (!recoveryPolicy) throw new Error("recovery policy is unavailable");
      const result = recoveryPolicy.executeExplicitRecoveryAction(action, evidence, authorization);
      recoveryAuthorizationState = result.authorized ? "accepted" : result.state === "rejected" ? "rejected" : "none";
      return result;
    },
    inspectRecoveryDrill(evidence) {
      return recoveryDrill.inspect(evidence);
    },
    diagnoseRecoveryDrill(evidence) {
      return recoveryDrill.diagnose(evidence);
    },
    prepareRecoveryDrill(evidence, authorization) {
      return recoveryDrill.prepare(evidence, authorization);
    },
    executeRecoveryDrill(action, evidence, authorization) {
      return recoveryDrill.execute(action, evidence, authorization);
    },
    verifyRecoveryDrill(evidence, authorization) {
      return recoveryDrill.verify(evidence, authorization);
    },
    async establishOwnership() {
      if (!options.ownership || !delivered) throw new Error("ownership token is not available");
      await options.ownership.establishOwnership(options.ownership.createToken(delivered));
    },
    async releaseOwnership(reason) {
      if (!options.ownership) throw new Error("ownership service is unavailable");
      await options.ownership.releaseOwnership(reason);
    },
    async fenceOwner(reason) {
      if (!options.ownership) throw new Error("ownership service is unavailable");
      await options.ownership.fenceOwner(reason);
    },
    inspectRevocation: (grantId) => options.issuer.inspectRevocation(grantId),
    inspect() {
      const candidateState = options.candidate.inspectState();
      const revokedGrantIds = options.revokedGrantIds?.() ?? [];
      const recovery = recoveryInspection();
      return Object.freeze({
        issuerInstanceId: options.issuerInstanceId,
        candidateInstanceId: options.candidateInstanceId,
        candidateState,
        eligibility: evaluateAuthorityState(candidateState.state === "authoritative" ? "authoritative" : "unknown"),
        deliveredGrantId: delivered?.grantId,
        deliveredIssuerInstanceId: delivered?.issuerInstanceId,
        issuer: options.issuer.inspect(),
        audits: options.issuer.audits(),
        revokedGrantIds: Object.freeze([...revokedGrantIds]),
        revocations: options.issuer.revocations(),
        ownership: options.ownership?.inspectOwnership(),
        lastTransition,
        recovery,
      });
    },
  };
}
