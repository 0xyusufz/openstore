import { randomBytes } from "crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import {
  canTransitionClaim,
  type DeleteIfUnclaimedResult,
  type PieceClaim,
  validatePieceClaim,
} from "../../packages/provenance/index.js";

export interface PieceProvenanceStore {
  createClaim(claim: PieceClaim): Promise<PieceClaim>;
  associatePiece(pieceId: string, claimId: string, writePiece: () => Promise<void>): Promise<void>;
  markReferenced(pieceId: string, claimId: string): Promise<PieceClaim>;
  releaseClaim(pieceId: string, claimId: string, clientNamespace: string): Promise<PieceClaim>;
  reconcile(pieceId: string, claimId: string): Promise<PieceClaim | undefined>;
  deleteIfUnclaimed(pieceId: string, deletePiece: () => Promise<"deleted" | "not-found">): Promise<DeleteIfUnclaimedResult>;
  listClaims(pieceId: string): Promise<PieceClaim[]>;
}

export function createPieceProvenanceStore(directory: string): PieceProvenanceStore {
  const dir = resolve(directory);
  const locks = new Map<string, Promise<void>>();

  function pathFor(pieceId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pieceId)) throw new TypeError("pieceId is invalid");
    return join(dir, `${pieceId}.json`);
  }
  async function withLock<T>(pieceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(pieceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const queued = previous.then(() => current);
    locks.set(pieceId, queued);
    await previous;
    try { return await fn(); } finally {
      release();
      if (locks.get(pieceId) === queued) locks.delete(pieceId);
    }
  }
  async function readClaims(pieceId: string): Promise<PieceClaim[]> {
    try {
      const parsed = JSON.parse(await readFile(pathFor(pieceId), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { claims?: unknown }).claims)) throw new Error("malformed provenance metadata");
      const claims = (parsed as { claims: PieceClaim[] }).claims;
      claims.forEach(validatePieceClaim);
      return claims.map((claim) => ({ ...claim }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`malformed provenance metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function writeClaims(pieceId: string, claims: PieceClaim[]): Promise<void> {
    claims.forEach(validatePieceClaim);
    await mkdir(dir, { recursive: true });
    const target = pathFor(pieceId);
    const temp = join(dir, `.tmp.${randomBytes(8).toString("hex")}.json`);
    try {
      await writeFile(temp, JSON.stringify({ version: 1, claims }, null, 2), { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, target);
    } catch (error) {
      try { await unlink(temp); } catch {}
      throw error;
    }
  }
  async function transition(pieceId: string, claimId: string, next: PieceClaim["state"], clientNamespace?: string): Promise<PieceClaim> {
    return withLock(pieceId, async () => {
      const claims = await readClaims(pieceId);
      const index = claims.findIndex((claim) => claim.claimId === claimId);
      if (index < 0) throw new Error("claim not found");
      const current = claims[index]!;
      if (clientNamespace !== undefined && current.clientNamespace !== clientNamespace) throw new Error("claim owner mismatch");
      if (!canTransitionClaim(current.state, next)) throw new Error(`invalid claim transition: ${current.state} -> ${next}`);
      const updated = { ...current, state: next, updatedAt: Date.now() };
      claims[index] = updated;
      await writeClaims(pieceId, claims);
      return updated;
    });
  }
  return {
    async createClaim(claim) {
      validatePieceClaim(claim);
      return withLock(claim.pieceId, async () => {
        const claims = await readClaims(claim.pieceId);
        const existing = claims.find((candidate) => candidate.claimId === claim.claimId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(claim)) throw new Error("claim ID conflict");
          return existing;
        }
        if (claims.some((candidate) => candidate.operationId === claim.operationId && candidate.claimId !== claim.claimId)) throw new Error("operation ID conflict");
        await writeClaims(claim.pieceId, [...claims, { ...claim }]);
        return { ...claim };
      });
    },
    async associatePiece(pieceId, claimId, writePiece) {
      return withLock(pieceId, async () => {
        const claims = await readClaims(pieceId);
        const claim = claims.find((candidate) => candidate.claimId === claimId);
        if (!claim || claim.state === "released") throw new Error("active claim required");
        await writePiece();
      });
    },
    markReferenced: (pieceId, claimId) => transition(pieceId, claimId, "referenced"),
    releaseClaim: (pieceId, claimId, clientNamespace) => transition(pieceId, claimId, "released", clientNamespace),
    async reconcile(pieceId, claimId) {
      const claims = await readClaims(pieceId);
      return claims.find((claim) => claim.claimId === claimId);
    },
    async listClaims(pieceId) {
      return withLock(pieceId, async () => readClaims(pieceId));
    },
    async deleteIfUnclaimed(pieceId, deletePiece) {
      return withLock(pieceId, async () => {
        const claims = await readClaims(pieceId);
        const active = claims.filter((claim) => claim.state === "pending" || claim.state === "referenced");
        if (active.length > 0) return { status: "still-claimed", claims: active };
        const result = await deletePiece();
        if (result === "not-found") return { status: "not-found" };
        try { await unlink(pathFor(pieceId)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "conflict" };
        }
        return { status: "deleted" };
      });
    },
  };
}
