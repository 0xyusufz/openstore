import type { AuthorityGrantServiceOptions } from "./authority-grant.js";
import { createAuthorityGrantService, type SignedAuthorityGrant } from "./authority-grant.js";
import { type AuthorityIssuerService, type AuthorityIssuanceRequest } from "./authority-issuer.js";
import { evaluateAuthorityState, type AuthorityEligibility } from "./authority-contract.js";

export interface AuthorityControlPlaneRequest extends AuthorityIssuanceRequest {
  readonly operation: "request-grant";
}

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
  readonly lastTransition: "none" | "issued" | "delivered" | "accepted" | "revoked" | "failed";
};

export interface AuthorityControlPlane {
  requestGrant(request: AuthorityControlPlaneRequest): Promise<SignedAuthorityGrant>;
  issueGrant(request: AuthorityControlPlaneRequest): Promise<SignedAuthorityGrant>;
  deliverGrant(grant: SignedAuthorityGrant): Promise<void>;
  acceptGrant(grantId: string): Promise<void>;
  revokeGrant(grantId: string, callerIdentity: string): Promise<void>;
  inspect(): AuthorityControlPlaneInspection;
}

export interface AuthorityControlPlaneOptions {
  readonly issuer: AuthorityIssuerService;
  readonly candidate: ReturnType<typeof createAuthorityGrantService>;
  readonly candidateInstanceId: string;
  readonly issuerInstanceId: string;
  readonly revokedGrantIds?: () => readonly string[];
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createAuthorityControlPlane(options: AuthorityControlPlaneOptions): AuthorityControlPlane {
  if (!INSTANCE_ID.test(options.candidateInstanceId) || !INSTANCE_ID.test(options.issuerInstanceId)) {
    throw new TypeError("control-plane instance identity is invalid");
  }
  let delivered: SignedAuthorityGrant | undefined;
  let lastTransition: AuthorityControlPlaneInspection["lastTransition"] = "none";

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
    inspect() {
      const candidateState = options.candidate.inspectState();
      const revokedGrantIds = options.revokedGrantIds?.() ?? [];
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
        lastTransition,
      });
    },
  };
}
