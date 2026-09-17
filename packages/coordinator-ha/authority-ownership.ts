import { closeSync, chmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCoordinatorInstanceIdentity, type CoordinatorInstanceIdentity } from "./index.js";
import { signMessage, verifyMessage } from "../identity/index.js";
import type { SignedAuthorityGrant } from "./authority-grant.js";

export interface AuthorityOwnershipToken {
  readonly version: 1;
  readonly tokenId: string;
  readonly authorityEpoch: number;
  readonly ownerInstanceId: string;
  readonly grantId: string;
  readonly issuerInstanceId: string;
  readonly issuerPublicKey: string;
  readonly stateRevision: number;
  readonly stateDigest: string;
  readonly issuedAt: number;
  readonly signature: string;
}

export interface AuthorityOwnershipRecord {
  readonly version: 1;
  readonly state: "non-authoritative" | "authoritative" | "released" | "fenced";
  readonly authorityEpoch: number;
  readonly ownerInstanceId?: string;
  readonly acceptedGrantId?: string;
  readonly tokenId?: string;
  readonly stateRevision?: number;
  readonly stateDigest?: string;
  readonly issuerInstanceId?: string;
  readonly transitionedAt?: number;
  readonly conflict: boolean;
}

export interface AuthorityOwnershipService {
  createToken(grant: SignedAuthorityGrant): AuthorityOwnershipToken;
  validateOwnershipToken(token: AuthorityOwnershipToken): boolean;
  establishOwnership(token: AuthorityOwnershipToken): Promise<void>;
  inspectOwnership(): AuthorityOwnershipRecord;
  releaseOwnership(reason: string): Promise<void>;
  fenceOwner(reason: string): Promise<void>;
}

export interface AuthorityOwnershipOptions {
  readonly instance: CoordinatorInstanceIdentity;
  readonly issuerPrivateKey?: Buffer;
  readonly trustedIssuerPublicKeys: readonly string[];
  readonly persistencePath: string;
  readonly now?: () => number;
  readonly revokedGrantIds?: () => readonly string[];
  readonly state?: () => { revision: number; digest: string; fresh: boolean };
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().reduce<Record<string, unknown>>((out, key) => {
    out[key] = value[key]; return out;
  }, {}));
}

function payload(token: Omit<AuthorityOwnershipToken, "signature">): Buffer {
  return Buffer.from(`OPENSTORE-AUTHORITY-OWNERSHIP-V1\n${canonical(token)}`, "utf8");
}

export function createSignedOwnershipToken(
  grant: SignedAuthorityGrant,
  ownerInstanceId: string,
  issuerPrivateKey: Buffer,
  tokenId: string,
): AuthorityOwnershipToken {
  const unsigned: Omit<AuthorityOwnershipToken, "signature"> = {
    version: 1, tokenId, authorityEpoch: grant.authorityEpoch, ownerInstanceId,
    grantId: grant.grantId, issuerInstanceId: grant.issuerInstanceId,
    issuerPublicKey: grant.issuerPublicKey, stateRevision: grant.stateRevision,
    stateDigest: grant.stateDigest, issuedAt: grant.issuedAt,
  };
  return Object.freeze({ ...unsigned, signature: signMessage(issuerPrivateKey, payload(unsigned)).toString("base64") });
}

export function createAuthorityOwnershipService(options: AuthorityOwnershipOptions): AuthorityOwnershipService {
  const now = options.now ?? (() => Date.now());
  const trusted = new Set(options.trustedIssuerPublicKeys);
  if (!INSTANCE_ID.test(options.instance.instanceId) || trusted.size !== 1 || !options.persistencePath) throw new TypeError("ownership configuration is invalid");
  let record: AuthorityOwnershipRecord = Object.freeze({ version: 1, state: "non-authoritative", authorityEpoch: 0, conflict: false });
  let healthy = true;
  try {
    const parsed = JSON.parse(readFileSync(options.persistencePath, "utf8")) as AuthorityOwnershipRecord;
    if (parsed.version !== 1 || !["non-authoritative", "authoritative", "released", "fenced"].includes(parsed.state) ||
      !Number.isSafeInteger(parsed.authorityEpoch) || parsed.authorityEpoch < 0 || typeof parsed.conflict !== "boolean" ||
      (parsed.ownerInstanceId !== undefined && !INSTANCE_ID.test(parsed.ownerInstanceId)) ||
      (parsed.tokenId !== undefined && !ID.test(parsed.tokenId)) ||
      (parsed.acceptedGrantId !== undefined && !ID.test(parsed.acceptedGrantId))) throw new Error("invalid ownership state");
    record = Object.freeze(parsed);
  } catch { healthy = false; }
  const persist = (next: AuthorityOwnershipRecord): void => {
    if (!healthy && record.state === "non-authoritative" && readFileSafe(options.persistencePath)) throw new Error("ownership persistence is unavailable");
    const path = options.persistencePath; mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`; const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(next)}\n`, "utf8"); fsyncSync(fd); closeSync(fd); chmodSync(temp, 0o600); renameSync(temp, path);
      const directoryFd = openSync(dirname(path), "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      record = Object.freeze(next); healthy = true;
    } catch (error) { try { closeSync(fd); } catch {} try { unlinkSync(temp); } catch {} healthy = false; throw error; }
  };
  const validate = (token: AuthorityOwnershipToken): void => {
    if (!token || token.version !== 1 || !ID.test(token.tokenId) || !INSTANCE_ID.test(token.ownerInstanceId) ||
      token.ownerInstanceId !== options.instance.instanceId || !ID.test(token.grantId) ||
      !INSTANCE_ID.test(token.issuerInstanceId) || !PUBLIC_KEY.test(token.issuerPublicKey) ||
      !trusted.has(token.issuerPublicKey) || !Number.isSafeInteger(token.authorityEpoch) || token.authorityEpoch < 0 ||
      !Number.isSafeInteger(token.stateRevision) || token.stateRevision < 0 || !DIGEST.test(token.stateDigest) ||
      !Number.isSafeInteger(token.issuedAt) || token.issuedAt <= 0 || typeof token.signature !== "string") throw new Error("ownership token is invalid");
    const key = Buffer.from(token.issuerPublicKey, "base64");
    if (createCoordinatorInstanceIdentity(key).instanceId !== token.issuerInstanceId) throw new Error("ownership issuer identity is invalid");
    const { signature: _signature, ...unsigned } = token;
    if (!verifyMessage(key, payload(unsigned), Buffer.from(token.signature, "base64"))) throw new Error("ownership token signature is invalid");
    if (options.revokedGrantIds) {
      const revoked = options.revokedGrantIds();
      if (!Array.isArray(revoked) || revoked.some((id) => typeof id !== "string")) throw new Error("ownership revocation status is unavailable");
      if (revoked.includes(token.grantId)) throw new Error("ownership grant is revoked");
    }
    const local = options.state?.();
    if (!local || !local.fresh || local.revision !== token.stateRevision || local.digest !== token.stateDigest) throw new Error("ownership state does not match");
    if (token.authorityEpoch < record.authorityEpoch) throw new Error("ownership token epoch is stale");
    if (record.state === "fenced" && record.tokenId === token.tokenId) throw new Error("ownership token is fenced");
  };
  return {
    createToken: (grant) => {
      if (!options.issuerPrivateKey) throw new Error("ownership token signing is unavailable");
      return createSignedOwnershipToken(grant, options.instance.instanceId, options.issuerPrivateKey, `owner-${grant.grantId}`);
    },
    validateOwnershipToken: (token) => { try { validate(token); return true; } catch { return false; } },
    async establishOwnership(token) {
      validate(token);
      if (record.state === "authoritative") {
        if (record.ownerInstanceId === token.ownerInstanceId && record.tokenId === token.tokenId) return;
        throw new Error("authority ownership conflict");
      }
      if (record.authorityEpoch === token.authorityEpoch && record.ownerInstanceId && record.ownerInstanceId !== token.ownerInstanceId) {
        throw new Error("authority epoch already has a different owner");
      }
      if (record.state === "fenced" && record.tokenId === token.tokenId) throw new Error("fenced ownership cannot be re-established");
      persist({ version: 1, state: "authoritative", authorityEpoch: token.authorityEpoch, ownerInstanceId: token.ownerInstanceId, acceptedGrantId: token.grantId, tokenId: token.tokenId, stateRevision: token.stateRevision, stateDigest: token.stateDigest, issuerInstanceId: token.issuerInstanceId, transitionedAt: now(), conflict: false });
    },
    inspectOwnership: () => Object.freeze({ ...record }),
    async releaseOwnership(_reason) { persist({ ...record, state: "released", transitionedAt: now() }); },
    async fenceOwner(_reason) { persist({ ...record, state: "fenced", transitionedAt: now() }); },
  };
}

function readFileSafe(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
