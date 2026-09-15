import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import { DEFAULT_CHUNK_SIZE, chunkData } from "../../packages/chunking/index.js";
import {
  CRYPTO_VERSION,
  KEY_BYTES,
  decryptChunk,
} from "../../packages/crypto/index.js";
import { decodeEncryptedPiece } from "../../packages/manifest/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { getPieceFromNodes } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { uploadBuffer } from "./upload.js";

const nodes: StorageNode[] = [];
let endpoints: StorageNodeEndpoint[] = [];
const dead: StorageNodeEndpoint = {
  id: "node-dead",
  baseUrl: "http://127.0.0.1:1",
};

beforeAll(async () => {
  for (const id of ["node-a", "node-b", "node-c"]) {
    const dir = await mkdtemp(join(tmpdir(), `openstore-up-${id}-`));
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    nodes.push(node);
    endpoints.push({ id, baseUrl: `http://127.0.0.1:${port}` });
  }
});

afterAll(async () => {
  for (const node of nodes) {
    await node.close();
  }
  for (const node of nodes) {
    await rm(node.storageDir, { recursive: true, force: true });
  }
});

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("upload pipeline (OPENSTORE-005)", () => {
  it("uploads a small buffer and returns manifest plus key", async () => {
    const data = Buffer.from("hello openstore file");
    const { manifest, encryptionKey } = await uploadBuffer(
      data,
      "hello.txt",
      endpoints,
    );

    expect(manifest.version).toBe(1);
    expect(manifest.fileId).toMatch(/^[0-9a-f]{32}$/);
    expect(manifest.filename).toBe("hello.txt");
    expect(manifest.size).toBe(data.length);
    expect(manifest.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(manifest.totalChunks).toBe(1);
    expect(manifest.cryptoVersion).toBe(CRYPTO_VERSION);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.pieceIds).toHaveLength(1);
    expect(encryptionKey).toBeInstanceOf(Uint8Array);
    expect(encryptionKey.length).toBe(KEY_BYTES);

    // Keys stay out of the manifest.
    expect("key" in manifest).toBe(false);
    expect("encryptionKey" in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(
      Buffer.from(encryptionKey).toString("hex"),
    );
  });

  it("splits larger buffers into multiple ordered chunks", async () => {
    const data = randomBytes(1000);
    const { manifest } = await uploadBuffer(data, "multi.bin", endpoints, {
      chunkSize: 256,
    });

    expect(manifest.totalChunks).toBe(4);
    expect(manifest.chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(manifest.pieceIds).toEqual(manifest.chunks.map((c) => c.pieceId));
    expect(new Set(manifest.pieceIds).size).toBe(4);
    expect(
      manifest.chunks.reduce((sum, c) => sum + c.plaintextSize, 0),
    ).toBe(1000);
    expect(manifest.chunks[3]?.plaintextSize).toBe(232);
  });

  it("replicates every piece on all nodes", async () => {
    const { manifest } = await uploadBuffer(
      Buffer.from("replicated-file"),
      "repl.txt",
      endpoints,
    );

    expect([...manifest.nodeIds].sort()).toEqual([
      "node-a",
      "node-b",
      "node-c",
    ]);
    for (const endpoint of endpoints) {
      for (const pieceId of manifest.pieceIds) {
        const res = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`);
        expect(res.status).toBe(200);
      }
    }
  });

  it("manifest pieces decrypt back to the original bytes", async () => {
    const data = randomBytes(700);
    const chunkSize = 256;
    const { manifest, encryptionKey } = await uploadBuffer(
      data,
      "roundtrip.bin",
      endpoints,
      { chunkSize },
    );

    const slices = chunkData(data, chunkSize);
    for (let i = 0; i < manifest.chunks.length; i += 1) {
      const meta = manifest.chunks[i] as (typeof manifest.chunks)[number];
      const piece = await getPieceFromNodes(meta.pieceId, endpoints);
      // Piece IDs are SHA-256 over the stored bytes.
      expect(sha256Hex(piece.bytes)).toBe(meta.pieceId);
      expect(meta.plaintextHash).toBe(sha256Hex(slices[i]?.data as Buffer));
      const decrypted = decryptChunk(
        decodeEncryptedPiece(piece.bytes),
        encryptionKey,
      );
      expect(Buffer.from(decrypted).equals(slices[i]?.data as Buffer)).toBe(true);
    }
  });

  it("uploads successfully with a failed node and fails when all are down", async () => {
    const { manifest } = await uploadBuffer(
      Buffer.from("degraded-upload"),
      "degraded.txt",
      [...endpoints, dead],
      { timeoutMs: 3000 },
    );
    expect(manifest.nodeIds).not.toContain("node-dead");
    const piece = await getPieceFromNodes(manifest.pieceIds[0] as string, endpoints);
    expect(piece.bytes.length).toBeGreaterThan(0);

    await expect(
      uploadBuffer(Buffer.from("doomed"), "doomed.txt", [dead], {
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/on any node/);
  });
});
