import { describe, expect, it } from "vitest";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { clientNamespace, createOperationRecord, createOperationRecordStore, createPieceClaim } from "./provenance.js";

describe("client provenance helpers", () => {
  it("creates opaque client namespaces and claims without secret material", () => {
    const identity = { publicKey: Buffer.from("public-key"), privateKey: Buffer.from("private-key") };
    const claim = createPieceClaim("piece-1", "repair", identity);
    expect(clientNamespace(identity)).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.state).toBe("pending");
    expect(JSON.stringify(claim)).not.toContain("private-key");
    expect(JSON.stringify(claim)).not.toContain("recovery");
  });

  it("persists and validates operation transitions across reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-operations-"));
    const identity = { publicKey: Buffer.from("public-key"), privateKey: Buffer.from("private-key") };
    const claim = createPieceClaim("piece-1", "repair", identity);
    const record = createOperationRecord("piece-1", claim, "node-1234567890123456", "repair", 3);
    const first = createOperationRecordStore(dir);
    await first.create(record);
    await first.update(record.operationId, "stored");
    await first.update(record.operationId, "verified");
    const second = createOperationRecordStore(dir);
    expect((await second.load(record.operationId))?.state).toBe("verified");
    await expect(second.update(record.operationId, "released")).rejects.toThrow("invalid operation transition");
  });
});
