import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCoordinatorInstanceIdentity, type CoordinatorInstanceIdentity } from "./index.js";
import { createSignedAuthorityGrant, type SignedAuthorityGrant } from "./authority-grant.js";
import { type AuthorityGrant } from "./authority-contract.js";
import type { Identity } from "../identity/index.js";

export interface AuthorityIssuanceRequest {
  readonly version: 1;
  readonly callerIdentity: string;
  readonly candidateInstanceId: string;
  readonly authorityEpoch: number;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly grantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AuthorityIssuanceAuthorizer {
  authenticate(callerIdentity: string): boolean;
  mayIssue(callerIdentity: string, request: AuthorityIssuanceRequest): boolean;
}

export interface IssuedGrantAudit {
  readonly grantId: string;
  readonly candidateInstanceId: string;
  readonly authorityEpoch: number;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly issuerInstanceId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly callerIdentity: string;
  readonly outcome: "issued" | "revoked";
}

export interface AuthorityRevocationRecord {
  readonly version: 1;
  readonly recordId: string;
  readonly grantId: string;
  readonly candidateInstanceId: string;
  readonly authorityEpoch: number;
  readonly issuerInstanceId: string;
  readonly revokedAt: number;
  readonly reason: string;
  readonly callerIdentity: string;
}

interface IssuerState {
  readonly version: 1;
  readonly initialized: boolean;
  readonly issuerInstanceId: string;
  readonly issuerPublicKey: string;
  readonly authorityEpoch: number;
  readonly audits: readonly IssuedGrantAudit[];
  readonly revokedGrantIds: readonly string[];
  readonly revocations: readonly AuthorityRevocationRecord[];
}

export interface AuthorityIssuerOptions {
  readonly identity: Identity;
  readonly persistencePath: string;
  readonly authorizer: AuthorityIssuanceAuthorizer;
  readonly now?: () => number;
  readonly maxAuditRecords?: number;
}

export interface AuthorityIssuerService {
  bootstrap(initialEpoch: number): Promise<void>;
  issue(request: AuthorityIssuanceRequest): Promise<SignedAuthorityGrant>;
  revoke(grantId: string, callerIdentity: string, reason?: string): Promise<AuthorityRevocationRecord>;
  isRevoked(grantId: string): boolean;
  inspectRevocation(grantId: string): AuthorityRevocationRecord | undefined;
  revocations(): readonly AuthorityRevocationRecord[];
  inspect(): { readonly initialized: boolean; readonly issuerInstanceId: string; readonly authorityEpoch: number; readonly auditCount: number; readonly persistenceHealthy: boolean; readonly persistenceState: "missing" | "valid" | "corrupt" };
  audits(): readonly IssuedGrantAudit[];
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TIME_SKEW_MS = 30_000;
const MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;

function validRevocation(record: AuthorityRevocationRecord, issuerInstanceId: string): boolean {
  return record.version === 1 && record.recordId === `revoke-${record.grantId}` &&
    GRANT_ID.test(record.grantId) && INSTANCE_ID.test(record.candidateInstanceId) &&
    Number.isSafeInteger(record.authorityEpoch) && record.authorityEpoch >= 0 &&
    record.issuerInstanceId === issuerInstanceId && INSTANCE_ID.test(record.issuerInstanceId) &&
    Number.isSafeInteger(record.revokedAt) && record.revokedAt > 0 &&
    typeof record.reason === "string" && record.reason.length > 0 && record.reason.length <= 512 &&
    typeof record.callerIdentity === "string" && record.callerIdentity.length > 0 && record.callerIdentity.length <= 256;
}

function validRequest(request: AuthorityIssuanceRequest): boolean {
  return request.version === 1 && INSTANCE_ID.test(request.candidateInstanceId) &&
    Number.isSafeInteger(request.authorityEpoch) && request.authorityEpoch >= 0 &&
    Number.isSafeInteger(request.stateRevision) && request.stateRevision >= 0 &&
    DIGEST.test(request.stateDigest) && GRANT_ID.test(request.grantId) &&
    Number.isSafeInteger(request.issuedAt) && request.issuedAt > 0 &&
    Number.isSafeInteger(request.expiresAt) && request.expiresAt >= request.issuedAt;
}

export function createAuthorityIssuer(options: AuthorityIssuerOptions): AuthorityIssuerService {
  const now = options.now ?? (() => Date.now());
  const maxAuditRecords = options.maxAuditRecords ?? 1024;
  if (!options.persistencePath || !Number.isSafeInteger(maxAuditRecords) || maxAuditRecords <= 0 || maxAuditRecords > 10_000) throw new TypeError("issuer persistence configuration is invalid");
  const issuer = createCoordinatorInstanceIdentity(options.identity.publicKey);
  let current: IssuerState = {
    version: 1, initialized: false, issuerInstanceId: issuer.instanceId,
    issuerPublicKey: issuer.publicKey, authorityEpoch: 0, audits: [], revokedGrantIds: [], revocations: [],
  };
  let persistenceHealthy = true;
  let persistenceState: "missing" | "valid" | "corrupt" = "missing";
  try {
    const parsed = JSON.parse(readFileSync(options.persistencePath, "utf8")) as IssuerState;
    if (parsed.version !== 1 || parsed.issuerInstanceId !== issuer.instanceId || parsed.issuerPublicKey !== issuer.publicKey ||
      typeof parsed.initialized !== "boolean" || !Number.isSafeInteger(parsed.authorityEpoch) || parsed.authorityEpoch < 0 ||
      !Array.isArray(parsed.audits) || !Array.isArray(parsed.revokedGrantIds) || !Array.isArray(parsed.revocations) ||
      parsed.audits.length > maxAuditRecords || parsed.revocations.length > maxAuditRecords ||
      parsed.revocations.some((record) => !validRevocation(record, issuer.instanceId)) ||
      parsed.revokedGrantIds.some((grantId) => typeof grantId !== "string" || !GRANT_ID.test(grantId))) throw new Error("invalid issuer state");
    current = Object.freeze({ ...parsed, audits: Object.freeze([...parsed.audits]), revokedGrantIds: Object.freeze([...parsed.revokedGrantIds]), revocations: Object.freeze([...parsed.revocations]) });
    persistenceState = "valid";
  } catch {
    persistenceHealthy = !existsSync(options.persistencePath);
    persistenceState = persistenceHealthy ? "missing" : "corrupt";
  }
  const persist = (next: IssuerState): void => {
    const path = options.persistencePath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(next)}\n`, "utf8"); fsyncSync(fd); closeSync(fd); chmodSync(temp, 0o600); renameSync(temp, path);
      const directoryFd = openSync(dirname(path), "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      current = Object.freeze({ ...next, audits: Object.freeze([...next.audits]), revokedGrantIds: Object.freeze([...next.revokedGrantIds]), revocations: Object.freeze([...next.revocations]) });
      persistenceHealthy = true; persistenceState = "valid";
    } catch (error) { try { closeSync(fd); } catch {} try { unlinkSync(temp); } catch {} persistenceHealthy = false; throw error; }
  };
  const ensureCaller = (request: AuthorityIssuanceRequest): void => {
    if (!options.authorizer.authenticate(request.callerIdentity) || !options.authorizer.mayIssue(request.callerIdentity, request)) throw new Error("caller is not authorized to issue authority grants");
    if (request.callerIdentity === request.candidateInstanceId) throw new Error("candidate cannot issue its own authority grant");
  };
  const bootstrap = async (initialEpoch: number): Promise<void> => {
    if (current.initialized || !persistenceHealthy) throw new Error("issuer is already initialized or state is unavailable");
    if (!Number.isSafeInteger(initialEpoch) || initialEpoch < 0 || initialEpoch > MAX_EPOCH) throw new TypeError("initial authority epoch is invalid");
    persist({ ...current, initialized: true, authorityEpoch: initialEpoch });
  };
  const issue = async (request: AuthorityIssuanceRequest): Promise<SignedAuthorityGrant> => {
    ensureCaller(request);
    if (!current.initialized || !persistenceHealthy) throw new Error("issuer state is not initialized");
    if (!validRequest(request) || request.expiresAt - request.issuedAt > MAX_GRANT_LIFETIME_MS) throw new Error("authority issuance request is invalid");
    const timestamp = now();
    if (request.issuedAt > timestamp + MAX_TIME_SKEW_MS || request.expiresAt < timestamp) throw new Error("authority issuance time is invalid");
    if (request.authorityEpoch !== current.authorityEpoch) throw new Error("authority epoch does not match issuer state");
    if (current.revokedGrantIds.includes(request.grantId) || current.audits.some((audit) => audit.grantId === request.grantId)) throw new Error("grant ID is already used");
    if (current.audits.length >= maxAuditRecords) throw new Error("issuer audit capacity is exhausted");
    const audit: IssuedGrantAudit = { grantId: request.grantId, candidateInstanceId: request.candidateInstanceId, authorityEpoch: request.authorityEpoch, stateRevision: request.stateRevision, stateDigest: request.stateDigest, issuerInstanceId: issuer.instanceId, issuedAt: request.issuedAt, expiresAt: request.expiresAt, callerIdentity: request.callerIdentity, outcome: "issued" };
    const nextAudits = [...current.audits, audit];
    const grantFields: Omit<SignedAuthorityGrant, "signature"> = { version: 1, candidateInstanceId: request.candidateInstanceId, authorityEpoch: request.authorityEpoch, stateRevision: request.stateRevision, stateDigest: request.stateDigest, grantId: request.grantId, issuedAt: request.issuedAt, expiresAt: request.expiresAt, issuerInstanceId: issuer.instanceId, issuerPublicKey: issuer.publicKey };
    const grant = createSignedAuthorityGrant(grantFields, options.identity.privateKey);
    persist({ ...current, audits: nextAudits });
    return grant;
  };
  const revoke = async (grantId: string, callerIdentity: string, reason = "operator revocation"): Promise<AuthorityRevocationRecord> => {
    if (!options.authorizer.authenticate(callerIdentity) || !GRANT_ID.test(grantId) || typeof reason !== "string" || reason.length === 0 || reason.length > 512 || !current.audits.some((audit) => audit.grantId === grantId) || !options.authorizer.mayIssue(callerIdentity, { version: 1, callerIdentity, candidateInstanceId: current.audits.find((audit) => audit.grantId === grantId)?.candidateInstanceId ?? "", authorityEpoch: current.authorityEpoch, stateRevision: 0, stateDigest: "0".repeat(64), grantId, issuedAt: 1, expiresAt: 1 })) throw new Error("caller cannot revoke authority grant");
    const audit = current.audits.find((item) => item.grantId === grantId)!;
    const existing = current.revocations.find((record) => record.grantId === grantId);
    if (existing) {
      if (existing.reason !== reason || existing.callerIdentity !== callerIdentity) throw new Error("conflicting revocation metadata");
      return existing;
    }
    if (current.revocations.length >= maxAuditRecords) throw new Error("issuer revocation capacity is exhausted");
    const record: AuthorityRevocationRecord = {
      version: 1, recordId: `revoke-${grantId}`, grantId, candidateInstanceId: audit.candidateInstanceId,
      authorityEpoch: audit.authorityEpoch, issuerInstanceId: issuer.instanceId, revokedAt: now(),
      reason, callerIdentity,
    };
    const revokedAudit: IssuedGrantAudit = { ...audit, outcome: "revoked" };
    persist({ ...current, audits: [...current.audits.filter((item) => item.grantId !== grantId), revokedAudit], revokedGrantIds: [...current.revokedGrantIds, grantId], revocations: [...current.revocations, record] });
    return record;
  };
  return {
    bootstrap, issue, revoke,
    isRevoked: (grantId) => current.revokedGrantIds.includes(grantId),
    inspectRevocation: (grantId) => current.revocations.find((record) => record.grantId === grantId),
    revocations: () => Object.freeze(current.revocations.map((record) => ({ ...record }))),
    inspect: () => ({ initialized: current.initialized, issuerInstanceId: current.issuerInstanceId, authorityEpoch: current.authorityEpoch, auditCount: current.audits.length, persistenceHealthy, persistenceState }),
    audits: () => Object.freeze(current.audits.map((audit) => ({ ...audit }))),
  };
}
