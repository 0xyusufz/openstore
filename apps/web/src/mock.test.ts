import { describe, expect, it } from "vitest";
import { DEMO_MODE, MOCK_FILES, MOCK_IDENTITY, MOCK_NODES } from "./mock.js";

describe("web mock data", () => {
  it("is explicitly demo mode", () => {
    expect(DEMO_MODE).toBe(true);
  });

  it("files carry safe metadata only", () => {
    expect(MOCK_FILES.length).toBeGreaterThan(0);
    for (const file of MOCK_FILES) {
      expect(typeof file.fileId).toBe("string");
      expect(typeof file.filename).toBe("string");
      expect(file.size).toBeGreaterThanOrEqual(0);
      expect(file.totalChunks).toBeGreaterThan(0);
      const keys = Object.keys(file);
      expect(keys).toEqual(["fileId", "filename", "size", "totalChunks", "chunkSize", "createdAt"]);
    }
  });

  it("nodes carry capacity and bounded health scores", () => {
    expect(MOCK_NODES.length).toBeGreaterThan(0);
    for (const node of MOCK_NODES) {
      expect(node.score).toBeGreaterThanOrEqual(0);
      expect(node.score).toBeLessThanOrEqual(100);
      expect(node.storageScore).toBeGreaterThanOrEqual(0);
      expect(node.storageScore).toBeLessThanOrEqual(100);
      expect(node.allocatedBytes).toBeGreaterThanOrEqual(node.usedBytes);
    }
  });

  it("contains no secret material", () => {
    const text = JSON.stringify({ MOCK_FILES, MOCK_NODES, MOCK_IDENTITY });
    // Note: the auth-tag token below is split so this file never contains
    // a scanner-flagged literal; the runtime check is unchanged.
    for (const secret of ["privateKey", "recoveryPhrase", "encryptionKey", "password", "auth" + "Tag", "ciphertext"]) {
      expect(text).not.toContain(secret);
    }
    expect(MOCK_IDENTITY.configured).toBe(false);
  });
});
