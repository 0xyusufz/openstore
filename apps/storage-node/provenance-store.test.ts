import { mkdtemp, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createOpaqueId, type PieceClaim } from "../../packages/provenance/index.js";
import { createPieceProvenanceStore } from "./provenance-store.js";

function makeClaim(pieceId = "piece-1", namespace = "a".repeat(64)): PieceClaim {
  const now = Date.now();
  return { pieceId, claimId: createOpaqueId(), operationId: createOpaqueId(), clientNamespace: namespace, kind: "upload", state: "pending", createdAt: now, updatedAt: now };
}

describe("piece provenance store", () => {
  it("persists claims, enforces ownership, and conditionally deletes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-provenance-"));
    const store = createPieceProvenanceStore(dir);
    const claim = makeClaim();
    await store.createClaim(claim);
    await expect(store.releaseClaim(claim.pieceId, claim.claimId, "b".repeat(64))).rejects.toThrow("owner");
    await store.associatePiece(claim.pieceId, claim.claimId, async () => undefined);
    expect((await store.deleteIfUnclaimed(claim.pieceId, async () => "deleted")).status).toBe("still-claimed");
    await store.releaseClaim(claim.pieceId, claim.claimId, claim.clientNamespace);
    expect((await store.deleteIfUnclaimed(claim.pieceId, async () => "deleted")).status).toBe("deleted");
  });

  it("survives restart and keeps metadata restrictive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-provenance-"));
    const claim = makeClaim();
    await createPieceProvenanceStore(dir).createClaim(claim);
    expect((await createPieceProvenanceStore(dir).listClaims(claim.pieceId)).map((x) => x.claimId)).toEqual([claim.claimId]);
    const mode = (await stat(join(dir, `${claim.pieceId}.json`))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(join(dir, `${claim.pieceId}.json`), "utf8")).not.toContain("privateKey");
  });
});
