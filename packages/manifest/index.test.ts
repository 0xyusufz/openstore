import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import {
  buildManifest,
  decodeEncryptedPiece,
  encodeEncryptedPiece,
  generateFileId,
  hashPieceId,
} from "./index.js";
import type { ManifestChunk } from "./index.js";

const HEX_64_A = "a".repeat(64);
const HEX_64_B = "b".repeat(64);

function chunk(
  index: number,
  pieceId: string = HEX_64_A,
  nodeIds: string[] = ["node-a"],
): ManifestChunk {
  return {
    index,
    pieceId,
    plaintextHash: HEX_64_B,
    plaintextSize: 256,
    encryptedSize: 300,
    nodeIds,
  };
}

describe("manifest package (OPENSTORE-005)", () => {
  it("builds a manifest and derives piece/node IDs", () => {
    const manifest = buildManifest({
      fileId: "file-1",
      filename: "hello.txt",
      size: 512,
      chunkSize: 256,
      cryptoVersion: 1,
      chunks: [chunk(0, HEX_64_A, ["node-a", "node-b"]), chunk(1, HEX_64_B, ["node-b", "node-c"])],
    });

    expect(manifest.version).toBe(1);
    expect(manifest.totalChunks).toBe(2);
    expect(manifest.pieceIds).toEqual([HEX_64_A, HEX_64_B]);
    expect(manifest.nodeIds).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("rejects out-of-order chunks and key material", () => {
    expect(() =>
      buildManifest({
        fileId: "file-1",
        filename: "x.txt",
        size: 1,
        chunkSize: 1,
        cryptoVersion: 1,
        chunks: [chunk(1), chunk(0)],
      }),
    ).toThrow();
    expect(() =>
      buildManifest({
        fileId: "file-1",
        filename: "x.txt",
        size: 1,
        chunkSize: 1,
        cryptoVersion: 1,
        chunks: [chunk(0)],
        encryptionKey: "must-never-fit",
      } as never),
    ).toThrow();
  });

  it("encodes and decodes encrypted pieces", () => {
    const encrypted = {
      version: 1,
      iv: new Uint8Array(randomBytes(12)),
      ciphertext: new Uint8Array(Buffer.from("ciphertext-bytes")),
      authTag: new Uint8Array(randomBytes(16)),
    };
    const bytes = encodeEncryptedPiece(encrypted);
    const decoded = decodeEncryptedPiece(bytes);

    expect(decoded.version).toBe(1);
    expect(Buffer.from(decoded.iv).equals(Buffer.from(encrypted.iv))).toBe(true);
    expect(Buffer.from(decoded.ciphertext).equals(Buffer.from(encrypted.ciphertext))).toBe(true);
    expect(Buffer.from(decoded.authTag).equals(Buffer.from(encrypted.authTag))).toBe(true);
    expect(() => decodeEncryptedPiece(Buffer.from("not-json"))).toThrow();
  });

  it("hashes piece IDs and generates file IDs", () => {
    const bytes = Buffer.from("piece-bytes");
    expect(hashPieceId(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPieceId(bytes)).toBe(hashPieceId(Buffer.from("piece-bytes")));
    expect(hashPieceId(bytes)).not.toBe(hashPieceId(Buffer.from("other-bytes")));

    const first = generateFileId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(generateFileId()).not.toBe(first);
  });
});
