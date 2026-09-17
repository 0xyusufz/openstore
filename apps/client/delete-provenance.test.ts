import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import { buildManifest, hashPieceId } from "../../packages/manifest/index.js";
import { createStorageNode } from "../storage-node/index.js";
import { createOperationRecord, createOperationRecordStore, createPieceClaim, reconcileDeletedProvenanceOperations, type ProvenanceIdentity } from "./provenance.js";
import { deleteFile, DeleteFileError } from "./delete.js";
import type { P2PProvenanceTransport } from "../../packages/p2p/index.js";

function provenanceTransport(release: (claimId: string) => Promise<void>): P2PProvenanceTransport {
  return {
    createClaim: async () => { throw new Error("unused"); },
    storeClaimedPiece: async () => { throw new Error("unused"); },
    markClaimReferenced: async () => { throw new Error("unused"); },
    releaseClaim: async (_node, _piece, claimId) => { await release(claimId); return { pieceId: _piece, claimId, operationId: "operation-id-00000000", clientNamespace: "a".repeat(64), kind: "upload", state: "released", createdAt: 1, updatedAt: 1 }; },
    reconcileClaim: async () => undefined,
    deletePieceIfUnclaimed: async () => ({ status: "conflict" }),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openstore-delete-provenance-"));
  const node = createStorageNode({ storageDir: join(root, "node") });
  const port = await node.listen(0, "127.0.0.1");
  const identity = createIdentity() as ProvenanceIdentity;
  const endpoint = { id: "delete-provenance-node", baseUrl: `http://127.0.0.1:${port}` };
  const bytes = Buffer.from("opaque encrypted bytes for delete");
  const pieceId = hashPieceId(bytes);
  await fetch(`${endpoint.baseUrl}/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: pieceId, data: bytes.toString("base64") }) });
  const manifest = buildManifest({ fileId: "f".repeat(64), filename: "opaque", size: bytes.length, chunkSize: bytes.length, cryptoVersion: 1, chunks: [{ index: 0, pieceId, plaintextHash: "a".repeat(64), plaintextSize: bytes.length, encryptedSize: bytes.length, nodeIds: [endpoint.id] }] });
  const dir = await mkdtemp(join(root, "operations-"));
  const operationStore = createOperationRecordStore(dir);
  const claim = createPieceClaim(pieceId, "upload", identity);
  await operationStore.create(createOperationRecord(pieceId, claim, endpoint.id, "upload", 0, manifest.fileId));
  await operationStore.update(claim.operationId, "stored");
  await operationStore.update(claim.operationId, "verified");
  await operationStore.update(claim.operationId, "committed");
  return { root, node, endpoint, identity, pieceId, manifest, operationStore, claim };
}

describe("file deletion and provenance claims", () => {
  it("releases only the caller claim after successful deletion", async () => {
    const setupValue = await setup();
    const released: string[] = [];
    try {
      const report = await deleteFile(setupValue.manifest, [setupValue.endpoint], {
        identity: setupValue.identity,
        operationStore: setupValue.operationStore,
        provenanceTransport: provenanceTransport(async (id) => { released.push(id); }),
      });
      expect(report.failed).toHaveLength(0);
      expect(released).toEqual([setupValue.claim.claimId]);
      expect((await setupValue.operationStore.load(setupValue.claim.operationId))?.deletionState).toBe("released");
    } finally {
      await setupValue.node.close();
      await rm(setupValue.root, { recursive: true, force: true });
    }
  });

  it("keeps the claim protected when deletion fails, and records release failure after deletion", async () => {
    const first = await setup();
    try {
      await expect(deleteFile(first.manifest, [{ ...first.endpoint, baseUrl: "http://127.0.0.1:1" }], {
        identity: first.identity, operationStore: first.operationStore, provenanceTransport: provenanceTransport(async () => undefined),
      })).rejects.toBeInstanceOf(DeleteFileError);
      expect((await first.operationStore.load(first.claim.operationId))?.deletionState).toBe("pending");
    } finally { await first.node.close(); await rm(first.root, { recursive: true, force: true }); }

    const second = await setup();
    try {
      const report = await deleteFile(second.manifest, [second.endpoint], {
        identity: second.identity, operationStore: second.operationStore,
        provenanceTransport: provenanceTransport(async () => { throw new Error("release unavailable"); }),
      });
      expect(report.provenanceReleaseFailures).toHaveLength(1);
      expect((await second.operationStore.load(second.claim.operationId))?.deletionState).toBe("release-requested");
      const retried: string[] = [];
      const reconciliation = await reconcileDeletedProvenanceOperations(
        second.manifest.fileId,
        [second.endpoint],
        second.identity,
        second.operationStore,
        { timeoutMs: 1000, transport: provenanceTransport(async (id) => { retried.push(id); }) },
      );
      expect(reconciliation).toEqual({ released: 1, failed: 0 });
      expect(retried).toEqual([second.claim.claimId]);
      expect((await second.operationStore.load(second.claim.operationId))?.deletionState).toBe("released");
    } finally { await second.node.close(); await rm(second.root, { recursive: true, force: true }); }
  });
});
