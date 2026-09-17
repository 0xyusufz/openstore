import { mkdtemp, readFile, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { describe, expect, it } from "vitest";
import { createOpaqueId } from "../../packages/provenance/index.js";
import { createPieceProvenanceStore } from "../../apps/storage-node/provenance-store.js";
import { createOrphanScanner } from "../../apps/storage-node/orphan-scanner.js";

describe("Milestone 049C orphan cleanup", () => {
  it("retains legacy data and persists released cleanup state across a child-process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-049c-"));
    const pieceId = "a".repeat(64);
    const provenanceDir = join(root, ".provenance");
    const store = createPieceProvenanceStore(provenanceDir, 10);
    await writeFile(join(root, pieceId), "opaque ciphertext");
    await writeFile(join(root, "legacy-piece"), "legacy");
    const now = Date.now();
    const claim = {
      pieceId, claimId: createOpaqueId(), operationId: createOpaqueId(),
      clientNamespace: "b".repeat(64), kind: "upload" as const, state: "pending" as const,
      createdAt: now, updatedAt: now,
    };
    await store.createClaim(claim);
    await store.releaseClaim(pieceId, claim.claimId, claim.clientNamespace);
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      const file = process.argv[1];
      if (!fs.existsSync(file)) process.exit(2);
      JSON.parse(fs.readFileSync(file, "utf8"));
    `, join(provenanceDir, `${pieceId}.json`)], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
    });
    const scanner = createOrphanScanner({
      pieceDir: root, provenance: createPieceProvenanceStore(provenanceDir, 0),
      deletePiece: async (id) => { await unlink(join(root, id)); return "deleted"; }, batchSize: 100, maxDeletionsPerRun: 10,
    });
    expect((await scanner.runOnce()).deleted).toBe(1);
    await expect(readFile(join(root, pieceId))).rejects.toThrow();
    expect(await readFile(join(root, "legacy-piece"), "utf8")).toBe("legacy");
  });
});
