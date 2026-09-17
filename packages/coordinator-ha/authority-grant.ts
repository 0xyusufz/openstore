import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createCoordinatorInstanceIdentity, type CoordinatorInstanceIdentity } from "./index.js";
import { signMessage, verifyMessage } from "../identity/index.js";
import {
  type AuthorityGrant,
  type CoordinatorAuthorityController,
  type AuthorityEligibility,
  evaluateAuthorityState,
  validateAuthorityGrant,
} from "./authority-contract.js";

export type SignedAuthorityGrant = AuthorityGrant & {
  readonly issuerInstanceId: string;
  readonly issuerPublicKey: string;
  readonly expiresAt: number;
  readonly signature: string;
};

export interface AuthorityGrantState {
  readonly version: 1;
  readonly instanceId: string;
  readonly state: "non-authoritative" | "authoritative" | "revoked";
  readonly authorityEpoch: number;
  readonly acceptedGrantId?: string;
  readonly stateRevision?: number;
  readonly stateDigest?: string;
  readonly issuedAt?: number;
  readonly acceptedAt?: number;
}

export interface AuthorityGrantServiceOptions {
  readonly instance: CoordinatorInstanceIdentity;
  readonly trustedIssuerPublicKeys: readonly string[];
  readonly persistencePath?: string;
  readonly now?: () => number;
  readonly state?: () => { revision: number; digest: string; fresh: boolean };
  readonly revokedGrantIds?: () => readonly string[];
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_GRANT_AGE_MS = 24 * 60 * 60 * 1000;

function canonical(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("authority grant payload is invalid");
  return JSON.stringify(Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((out, key) => {
    out[key] = (value as Record<string, unknown>)[key]; return out;
  }, {}));
}

function signingPayload(grant: Omit<SignedAuthorityGrant, "signature">): Buffer {
  return Buffer.from(`OPENSTORE-AUTHORITY-GRANT-V1\n${canonical(grant)}`, "utf8");
}

export function createSignedAuthorityGrant(
  fields: Omit<SignedAuthorityGrant, "signature">,
  issuerPrivateKey: Buffer,
): SignedAuthorityGrant {
  return Object.freeze({ ...fields, signature: signMessage(issuerPrivateKey, signingPayload(fields)).toString("base64") });
}

export function createAuthorityGrantService(options: AuthorityGrantServiceOptions): CoordinatorAuthorityController & {
  inspectState(): AuthorityGrantState;
  persistenceHealthy(): boolean;
  acceptGrant(grant: SignedAuthorityGrant): Promise<void>;
  revoke(reason: string): Promise<void>;
} {
  const now = options.now ?? (() => Date.now());
  const trusted = new Set(options.trustedIssuerPublicKeys);
  if (!INSTANCE_ID.test(options.instance.instanceId) || trusted.size === 0 || trusted.size > 64) throw new TypeError("authority grant configuration is invalid");
  for (const key of trusted) if (!PUBLIC_KEY.test(key)) throw new TypeError("trusted issuer key is invalid");
  let current: AuthorityGrantState = Object.freeze({ version: 1, instanceId: options.instance.instanceId, state: "non-authoritative", authorityEpoch: 0 });
  let persistenceHealthy = true;
  if (options.persistencePath) {
    try {
      const parsed = JSON.parse(readFileSync(options.persistencePath, "utf8")) as AuthorityGrantState;
      if (parsed.version !== 1 || parsed.instanceId !== options.instance.instanceId || !["non-authoritative", "authoritative", "revoked"].includes(parsed.state) ||
        !Number.isSafeInteger(parsed.authorityEpoch) || parsed.authorityEpoch < 0) throw new Error("invalid persisted authority state");
      current = Object.freeze(parsed);
    } catch {
      persistenceHealthy = !existsSync(options.persistencePath);
      current = Object.freeze({ version: 1, instanceId: options.instance.instanceId, state: "non-authoritative", authorityEpoch: 0 });
    }
  }
  const persist = (next: AuthorityGrantState): void => {
    if (!options.persistencePath) { current = Object.freeze(next); return; }
    const path = options.persistencePath; mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(next)}\n`, "utf8"); fsyncSync(fd); closeSync(fd); chmodSync(temp, 0o600); renameSync(temp, path);
      const directoryFd = openSync(dirname(path), "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      current = Object.freeze(next);
    }
    catch (error) { try { closeSync(fd); } catch {} try { unlinkSync(temp); } catch {} throw error; }
  };
  const inspectState = (): AuthorityGrantState => Object.freeze({ ...current });
  const inspectAuthority = async (): Promise<AuthorityEligibility> => current.state === "authoritative"
    ? evaluateAuthorityState("authoritative") : evaluateAuthorityState("unknown");
  const validateGrant = (grant: SignedAuthorityGrant): void => {
    if (!validateAuthorityGrant(grant) || !grant.issuerInstanceId || !grant.issuerPublicKey || !grant.signature ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < grant.issuedAt) throw new Error("authority grant is invalid");
    if (grant.candidateInstanceId !== options.instance.instanceId) throw new Error("authority grant candidate does not match local instance");
    if (grant.revoked === true) throw new Error("authority grant is revoked");
    if (options.revokedGrantIds) {
      const revoked = options.revokedGrantIds();
      if (!Array.isArray(revoked) || revoked.some((id) => typeof id !== "string")) throw new Error("revocation status is malformed");
      if (revoked.includes(grant.grantId)) throw new Error("authority grant is revoked");
    }
    if (!trusted.has(grant.issuerPublicKey)) throw new Error("authority grant issuer is untrusted");
    const issuerKey = Buffer.from(grant.issuerPublicKey, "base64");
    if (createCoordinatorInstanceIdentity(issuerKey).instanceId !== grant.issuerInstanceId) throw new Error("authority grant issuer identity is invalid");
    const { signature: _signature, ...unsigned } = grant;
    if (!verifyMessage(issuerKey, signingPayload(unsigned), Buffer.from(grant.signature, "base64"))) throw new Error("authority grant signature is invalid");
    const timestamp = now();
    if (grant.expiresAt < timestamp || grant.issuedAt > timestamp + 30_000 || timestamp - grant.issuedAt > MAX_GRANT_AGE_MS) throw new Error("authority grant is stale or expired");
    const local = options.state?.();
    if (!local || !local.fresh || local.revision !== grant.stateRevision || local.digest !== grant.stateDigest) throw new Error("authority grant state does not match local state");
    if (grant.authorityEpoch < current.authorityEpoch) throw new Error("authority grant epoch is stale");
  };
  const acceptGrant = async (grant: SignedAuthorityGrant): Promise<void> => {
    validateGrant(grant);
    if (current.state === "authoritative") {
      if (current.acceptedGrantId === grant.grantId && current.authorityEpoch === grant.authorityEpoch) return;
      throw new Error("conflicting authority grant");
    }
    if (current.acceptedGrantId === grant.grantId) throw new Error("authority grant has already been consumed");
    if (grant.authorityEpoch === current.authorityEpoch && current.acceptedGrantId) throw new Error("authority grant replay conflict");
    persist({ version: 1, instanceId: options.instance.instanceId, state: "authoritative", authorityEpoch: grant.authorityEpoch, acceptedGrantId: grant.grantId, stateRevision: grant.stateRevision, stateDigest: grant.stateDigest, issuedAt: grant.issuedAt, acceptedAt: now() });
  };
  const revoke = async (_reason: string): Promise<void> => {
    persist({ ...current, state: "revoked", acceptedAt: now() });
  };
  return {
    requestPromotion: async () => { throw new Error("authority grants must be issued by a trusted external operator"); },
    validateAuthorityGrant: async (grant) => { try { validateGrant(grant as SignedAuthorityGrant); return true; } catch { return false; } },
    establishAuthority: async (grant) => acceptGrant(grant as SignedAuthorityGrant),
    revokeAuthority: revoke,
    inspectAuthority,
    demote: revoke,
    inspectState,
    persistenceHealthy: () => persistenceHealthy,
    acceptGrant,
    revoke,
  };
}
