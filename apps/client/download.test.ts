import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { generateEncryptionKey } from "../../packages/crypto/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { downloadBuffer } from "./download.js";
import { uploadBuffer } from "./upload.js";

const nodes: StorageNode[] = [];
let endpoints: StorageNodeEndpoint[] = [];
const dead: StorageNodeEndpoint = {
  id: "node-dead",
  baseUrl: "http://127.0.0.1:1",
};

beforeAll(async () => {
  for (const id of ["node-a", "node-b", "node-c"]) {
    const dir = await mkdtemp(join(tmpdir(), `openstore-dl-${id}-`));
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

async function fetchPiece(
  endpoint: StorageNodeEndpoint,
  pieceId: string,
): Promise<Buffer> {
  const res = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function overwritePiece(
  endpoint: StorageNodeEndpoint,
  pieceId: string,
  bytes: Buffer,
): Promise<void> {
  const res = await fetch(`${endpoint.baseUrl}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pieceId, data: bytes.toString("base64") }),
  });
  expect([200, 201]).toContain(res.status);
}

describe("download pipeline (OPENSTORE-006)", () => {
  it("1. upload → download returns exact original data", async () => {
    const original = Buffer.from("download-me-exactly");
    const { manifest, encryptionKey } = await uploadBuffer(
      original,
      "exact.txt",
      endpoints,
    );

    const recovered = await downloadBuffer(manifest, encryptionKey, endpoints);
    expect(recovered.equals(original)).toBe(true);
  });

  it("2. recovers a multi-chunk file", async () => {
    const original = randomBytes(1000);
    const { manifest, encryptionKey } = await uploadBuffer(
      original,
      "multi.bin",
      endpoints,
      { chunkSize: 256 },
    );
    expect(manifest.totalChunks).toBe(4);

    const recovered = await downloadBuffer(manifest, encryptionKey, endpoints);
    expect(recovered.equals(original)).toBe(true);
  });

  it("3. recovers with one replica unavailable", async () => {
    const original = Buffer.from("replica-fallback-data");
    const { manifest, encryptionKey } = await uploadBuffer(
      original,
      "fallback.txt",
      endpoints,
    );

    const recovered = await downloadBuffer(manifest, encryptionKey, [dead, ...endpoints], {
      timeoutMs: 3000,
    });
    expect(recovered.equals(original)).toBe(true);
  });

  it("4. rejects a corrupted stored piece", async () => {
    const { manifest, encryptionKey } = await uploadBuffer(
      Buffer.from("tamper-me"),
      "tamper.txt",
      endpoints,
    );
    const pieceId = manifest.pieceIds[0] as string;

    const tampered = await fetchPiece(endpoints[0] as StorageNodeEndpoint, pieceId);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    for (const endpoint of endpoints) {
      await overwritePiece(endpoint, pieceId, tampered);
    }

    await expect(
      downloadBuffer(manifest, encryptionKey, endpoints),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("5. rejects a wrong encryption key", async () => {
    const { manifest } = await uploadBuffer(
      Buffer.from("secret-file-data"),
      "secret.txt",
      endpoints,
    );

    await expect(
      downloadBuffer(manifest, generateEncryptionKey(), endpoints),
    ).rejects.toThrow(/decryption failed/);
  });

  it("6. fails clearly when a piece is missing everywhere", async () => {
    const { manifest, encryptionKey } = await uploadBuffer(
      Buffer.from("vanishing-data"),
      "gone.txt",
      endpoints,
    );
    const pieceId = manifest.pieceIds[0] as string;

    for (const endpoint of endpoints) {
      const res = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    }

    await expect(
      downloadBuffer(manifest, encryptionKey, endpoints),
    ).rejects.toThrow(/unavailable/);
  });

  it("7. reconstructed bytes exactly match the original", async () => {
    const palette = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const random = randomBytes(20000);
    for (const [filename, original] of [
      ["palette.bin", palette],
      ["random.bin", random],
    ] as Array<[string, Buffer]>) {
      const { manifest, encryptionKey } = await uploadBuffer(
        original,
        filename,
        endpoints,
        { chunkSize: 4096 },
      );
      const recovered = await downloadBuffer(manifest, encryptionKey, endpoints);
      expect(recovered.length).toBe(original.length);
      expect(recovered.equals(original)).toBe(true);
    }
  });
});
