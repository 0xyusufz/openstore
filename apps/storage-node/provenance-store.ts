import { mkdir, readFile, readdir, unlink } from "fs/promises";
import { join, resolve } from "path";
import {
  canTransitionClaim,
  type DeleteIfUnclaimedResult,
  type PieceClaim,
  type PieceProvenanceEnvelope,
  validatePieceClaim,
} from "../../packages/provenance/index.js";
import { durableWriteFileSync } from "./durable-fs.js";

export const DEFAULT_PROVENANCE_GRACE_MS = 24 * 60 * 60 * 1000;
export type ProvenanceInspectionReason = "eligible" | "active-claim" | "grace-period" | "missing" | "corrupt" | "unsupported";

export interface PieceProvenanceStore {
  createClaim(claim: PieceClaim): Promise<PieceClaim>;
  associatePiece(pieceId: string, claimId: string, writePiece: () => Promise<void>): Promise<void>;
  markReferenced(pieceId: string, claimId: string): Promise<PieceClaim>;
  releaseClaim(pieceId: string, claimId: string, clientNamespace: string): Promise<PieceClaim>;
  reconcile(pieceId: string, claimId: string): Promise<PieceClaim | undefined>;
  deleteIfUnclaimed(pieceId: string, deletePiece: () => Promise<"deleted" | "not-found">): Promise<DeleteIfUnclaimedResult>;
  listClaims(pieceId: string): Promise<PieceClaim[]>;
  listManagedPieces(): Promise<string[]>;
  inspect(pieceId: string, now?: number): Promise<{ eligible: boolean; reason: ProvenanceInspectionReason }>;
}

export function createPieceProvenanceStore(directory: string, gracePeriodMs = DEFAULT_PROVENANCE_GRACE_MS): PieceProvenanceStore {
  if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) throw new RangeError("grace period must be a non-negative safe integer");
  const dir = resolve(directory);
  const locks = new Map<string, Promise<void>>();
  const valid = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const pathFor = (pieceId: string) => {
    if (!valid(pieceId)) throw new TypeError("pieceId is invalid");
    return join(dir, `${pieceId}.json`);
  };
  async function withLock<T>(pieceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(pieceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const queued = previous.then(() => current);
    locks.set(pieceId, queued);
    await previous;
    try { return await fn(); } finally { release(); if (locks.get(pieceId) === queued) locks.delete(pieceId); }
  }
  async function readEnvelope(pieceId: string): Promise<PieceProvenanceEnvelope | undefined> {
    try {
      const value = JSON.parse(await readFile(pathFor(pieceId), "utf8")) as Partial<PieceProvenanceEnvelope>;
      if (value.version !== 2) throw new Error("unsupported");
      const managedAt = value.managedAt;
      const cleanupEligibleAfter = value.cleanupEligibleAfter;
      if (value.pieceId !== pieceId || typeof managedAt !== "number" || typeof cleanupEligibleAfter !== "number" ||
          !Number.isSafeInteger(managedAt) || !Number.isSafeInteger(cleanupEligibleAfter) ||
          cleanupEligibleAfter < managedAt || !Array.isArray(value.claims)) throw new Error("corrupt");
      value.claims.forEach(validatePieceClaim);
      return { version: 2, pieceId, managedAt, cleanupEligibleAfter, claims: value.claims.map((claim) => ({ ...claim })) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(String(error).includes("unsupported") ? "unsupported provenance metadata" : "corrupt provenance metadata");
    }
  }
  async function writeEnvelope(envelope: PieceProvenanceEnvelope): Promise<void> {
    envelope.claims.forEach(validatePieceClaim);
    await mkdir(dir, { recursive: true });
    // Crash-safe: temp + file fsync + atomic rename + parent dir fsync, so a
    // crash can never leave a partially visible/corrupt envelope behind.
    // Temp names never match `<pieceId>.json`, so they are never read as state.
    durableWriteFileSync(pathFor(envelope.pieceId), Buffer.from(JSON.stringify(envelope, null, 2), "utf8"), {
      mode: 0o600,
      tempPrefix: ".tmp",
    });
  }
  async function transition(pieceId: string, claimId: string, next: PieceClaim["state"], owner?: string): Promise<PieceClaim> {
    return withLock(pieceId, async () => {
      const envelope = await readEnvelope(pieceId);
      if (!envelope) throw new Error("provenance metadata missing");
      const index = envelope.claims.findIndex((claim) => claim.claimId === claimId);
      if (index < 0) throw new Error("claim not found");
      const current = envelope.claims[index]!;
      if (owner !== undefined && current.clientNamespace !== owner) throw new Error("claim owner mismatch");
      if (!canTransitionClaim(current.state, next)) throw new Error(`invalid claim transition: ${current.state} -> ${next}`);
      const claims = envelope.claims.slice();
      claims[index] = { ...current, state: next, updatedAt: Date.now() };
      await writeEnvelope({ ...envelope, cleanupEligibleAfter: Math.max(envelope.cleanupEligibleAfter, Date.now() + gracePeriodMs), claims });
      return claims[index]!;
    });
  }
  return {
    async createClaim(claim) {
      validatePieceClaim(claim);
      return withLock(claim.pieceId, async () => {
        const existing = await readEnvelope(claim.pieceId);
        const prior = existing?.claims.find((candidate) => candidate.claimId === claim.claimId);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(claim)) throw new Error("claim ID conflict");
          return prior;
        }
        if (existing?.claims.some((candidate) => candidate.operationId === claim.operationId)) throw new Error("operation ID conflict");
        const now = Date.now();
        await writeEnvelope({
          version: 2, pieceId: claim.pieceId, managedAt: existing?.managedAt ?? now,
          cleanupEligibleAfter: Math.max(existing?.cleanupEligibleAfter ?? 0, now + gracePeriodMs),
          claims: [...(existing?.claims ?? []), { ...claim }],
        });
        return { ...claim };
      });
    },
    async associatePiece(pieceId, claimId, writePiece) {
      return withLock(pieceId, async () => {
        const envelope = await readEnvelope(pieceId);
        const claim = envelope?.claims.find((candidate) => candidate.claimId === claimId);
        if (!claim || claim.state === "released") throw new Error("active claim required");
        await writePiece();
      });
    },
    markReferenced: (pieceId, claimId) => transition(pieceId, claimId, "referenced"),
    releaseClaim: (pieceId, claimId, owner) => transition(pieceId, claimId, "released", owner),
    async reconcile(pieceId, claimId) {
      const envelope = await readEnvelope(pieceId);
      return envelope?.claims.find((claim) => claim.claimId === claimId);
    },
    async listClaims(pieceId) {
      return withLock(pieceId, async () => {
        const envelope = await readEnvelope(pieceId);
        if (!envelope) throw new Error("provenance metadata missing");
        return envelope.claims;
      });
    },
    async deleteIfUnclaimed(pieceId, deletePiece) {
      return withLock(pieceId, async () => {
        let envelope: PieceProvenanceEnvelope | undefined;
        try { envelope = await readEnvelope(pieceId); } catch { return { status: "conflict" }; }
        if (!envelope) return { status: "conflict" };
        const active = envelope.claims.filter((claim) => claim.state !== "released");
        if (active.length > 0 || Date.now() < envelope.cleanupEligibleAfter) return { status: "still-claimed", claims: active };
        const result = await deletePiece();
        if (result === "not-found") return { status: "not-found" };
        try { await unlink(pathFor(pieceId)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "conflict" };
        }
        return { status: "deleted" };
      });
    },
    async listManagedPieces() {
      try { return (await readdir(dir)).filter((entry) => entry.endsWith(".json") && !entry.startsWith(".tmp.")).map((entry) => entry.slice(0, -5)).filter(valid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    async inspect(pieceId, now = Date.now()) {
      return withLock(pieceId, async () => {
        try {
          const envelope = await readEnvelope(pieceId);
          if (!envelope) return { eligible: false, reason: "missing" as const };
          if (envelope.claims.some((claim) => claim.state !== "released")) return { eligible: false, reason: "active-claim" as const };
          if (now < envelope.cleanupEligibleAfter) return { eligible: false, reason: "grace-period" as const };
          return { eligible: true, reason: "eligible" as const };
        } catch (error) {
          return { eligible: false, reason: String(error).includes("unsupported") ? "unsupported" as const : "corrupt" as const };
        }
      });
    },
  };
}
