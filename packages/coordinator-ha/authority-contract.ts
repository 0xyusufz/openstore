import type { CoordinatorInstanceIdentity } from "./index.js";

/** States used by a future authority mechanism. They do not change 053G runtime behavior. */
export type CoordinatorAuthorityState =
  | "authoritative"
  | "replica"
  | "stale"
  | "conflicted"
  | "unavailable"
  | "rejected"
  | "unknown";

export type AuthorityEvidenceRejection =
  | "missing"
  | "identity-mismatch"
  | "revision-invalid"
  | "digest-invalid"
  | "proof-unverified"
  | "not-fresh"
  | "not-explicitly-authorized"
  | "source-untrusted"
  | "replay-risk"
  | "authority-ambiguous";

export interface AuthorityEvidence {
  readonly version: 1;
  readonly instanceId: string;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly proofVerified: boolean;
  readonly sourceTrusted: boolean;
  readonly fresh: boolean;
  readonly explicitlyAuthorized: boolean;
  readonly antiReplayValid: boolean;
  readonly splitBrainFree: boolean;
  readonly authorityEpoch?: number;
}

export interface AuthorityEligibility {
  readonly eligible: boolean;
  readonly state: CoordinatorAuthorityState;
  readonly placementAuthorized: boolean;
  readonly existingManifestOperationsAllowed: boolean;
  readonly snapshotExportAllowed: boolean;
  readonly snapshotImportAllowed: boolean;
  readonly reason?: AuthorityEvidenceRejection;
}

export interface PromotionRequest {
  readonly version: 1;
  readonly candidate: CoordinatorInstanceIdentity;
  readonly requestedAt: number;
  readonly evidence: AuthorityEvidence;
}

export interface AuthorityGrant {
  readonly version: 1;
  readonly candidateInstanceId: string;
  readonly authorityEpoch: number;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly grantId: string;
  readonly issuedAt: number;
}

/** Contract only: implementations must be supplied by a future explicit authority mechanism. */
export interface CoordinatorAuthorityController {
  requestPromotion(request: PromotionRequest): Promise<AuthorityGrant>;
  validateAuthorityGrant(grant: AuthorityGrant): Promise<boolean>;
  establishAuthority(grant: AuthorityGrant): Promise<void>;
  revokeAuthority(reason: string): Promise<void>;
  inspectAuthority(): Promise<AuthorityEligibility>;
  demote(reason: string): Promise<void>;
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function validEpoch(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

export function evaluateAuthorityState(state: CoordinatorAuthorityState): AuthorityEligibility {
  const usableExisting = state !== "rejected" && state !== "unknown" && state !== "unavailable";
  return Object.freeze({
    eligible: state === "authoritative",
    state,
    placementAuthorized: state === "authoritative",
    existingManifestOperationsAllowed: usableExisting,
    snapshotExportAllowed: state === "authoritative",
    snapshotImportAllowed: true,
    ...(state === "authoritative" ? {} : { reason: "authority-ambiguous" as const }),
  });
}

export function validatePromotionEvidence(
  evidence: AuthorityEvidence | undefined,
  candidateInstanceId?: string,
): AuthorityEligibility {
  if (!evidence) return Object.freeze({ ...evaluateAuthorityState("unknown"), reason: "missing" });
  let reason: AuthorityEvidenceRejection | undefined;
  if (evidence.version !== 1 || !INSTANCE_ID.test(evidence.instanceId) || (candidateInstanceId !== undefined && evidence.instanceId !== candidateInstanceId)) reason = "identity-mismatch";
  else if (!Number.isSafeInteger(evidence.stateRevision) || evidence.stateRevision < 0) reason = "revision-invalid";
  else if (!DIGEST.test(evidence.stateDigest)) reason = "digest-invalid";
  else if (!validEpoch(evidence.authorityEpoch)) reason = "revision-invalid";
  else if (!evidence.proofVerified) reason = "proof-unverified";
  else if (!evidence.fresh) reason = "not-fresh";
  else if (!evidence.explicitlyAuthorized) reason = "not-explicitly-authorized";
  else if (!evidence.sourceTrusted) reason = "source-untrusted";
  else if (!evidence.antiReplayValid) reason = "replay-risk";
  else if (!evidence.splitBrainFree) reason = "authority-ambiguous";
  if (reason) return Object.freeze({ ...evaluateAuthorityState("unknown"), reason });
  return Object.freeze({
    state: "authoritative",
    eligible: true,
    placementAuthorized: true,
    existingManifestOperationsAllowed: true,
    snapshotExportAllowed: true,
    snapshotImportAllowed: true,
  });
}

export function validateAuthorityGrant(grant: AuthorityGrant | undefined): boolean {
  return Boolean(grant &&
    grant.version === 1 &&
    INSTANCE_ID.test(grant.candidateInstanceId) &&
    Number.isSafeInteger(grant.authorityEpoch) && grant.authorityEpoch >= 0 &&
    Number.isSafeInteger(grant.stateRevision) && grant.stateRevision >= 0 &&
    DIGEST.test(grant.stateDigest) &&
    GRANT_ID.test(grant.grantId) &&
    Number.isSafeInteger(grant.issuedAt) && grant.issuedAt > 0);
}
