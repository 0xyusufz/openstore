import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createOpaqueId, type PieceClaim } from "../../packages/provenance/index.js";
import { createPieceProvenanceStore } from "./provenance-store.js";
import { createOrphanScanner } from "./orphan-scanner.js";

const claim = (pieceId: string, state: PieceClaim["state"]): PieceClaim => {
  const now = Date.now();
  return { pieceId, claimId: createOpaqueId(), operationId: createOpaqueId(), clientNamespace: "a".repeat(64), kind: "repair", state, createdAt: now, updatedAt: now };
};

describe("orphan scanner", () => {
  it("deletes only released managed pieces after grace and retains legacy/corrupt files", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-scanner-"));
    const provenance = createPieceProvenanceStore(join(root, ".provenance"), 0);
    await writeFile(join(root, "released-piece-0001"), "opaque");
    await writeFile(join(root, "legacy-piece-0001"), "opaque");
    await writeFile(join(root, "corrupt-piece-0001"), "opaque");
    const released = claim("released-piece-0001", "pending");
    await provenance.createClaim(released);
    await provenance.releaseClaim(released.pieceId, released.claimId, released.clientNamespace);
    await writeFile(join(root, ".provenance", "corrupt-piece-0001.json"), "{broken");
    const deleted: string[] = [];
    const scanner = createOrphanScanner({ pieceDir: root, provenance, maxDeletionsPerRun: 1, batchSize: 100, deletePiece: async (id) => { deleted.push(id); return "deleted"; } });
    const result = await scanner.runOnce();
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual(["released-piece-0001"]);
    expect(await scanner.status()).toMatchObject({ state: "paused" });
  });

  it("does not delete pending or referenced claims and supports cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-scanner-"));
    const provenance = createPieceProvenanceStore(join(root, ".provenance"), 0);
    for (const state of ["pending", "referenced"] as const) {
      const pieceId = `piece-${state}`;
      await writeFile(join(root, pieceId), "opaque");
      const value = claim(pieceId, state);
      await provenance.createClaim(value);
    }
    const scanner = createOrphanScanner({ pieceDir: root, provenance, deletePiece: async () => "deleted" });
    scanner.cancel();
    expect((await scanner.runOnce()).deleted).toBe(0);
  });
});
