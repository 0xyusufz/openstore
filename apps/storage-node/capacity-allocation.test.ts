import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapacityAllocation } from "./capacity-allocation.js";

async function dir() { return mkdtemp(join(tmpdir(), "openstore-allocation-")); }

describe("durable storage capacity allocation", () => {
  it("creates valid allocation state and persists increases/decreases", async () => {
    const root = await dir();
    try {
      const allocation = createCapacityAllocation(root, 1024);
      expect(allocation.state()).toMatchObject({ allocationBytes: 1024, usedBytes: 0, reservedBytes: 0 });
      allocation.updateUsed(400);
      expect(allocation.setAllocation(800).availableBytes).toBeGreaterThan(0);
      expect(createCapacityAllocation(root, 800).state().usedBytes).toBe(400);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects invalid, over-capacity, and below-usage allocations", async () => {
    const root = await dir();
    try {
      const allocation = createCapacityAllocation(root, 1024);
      expect(() => allocation.setAllocation(0)).toThrow();
      expect(() => allocation.setAllocation(-1)).toThrow();
      expect(() => allocation.setAllocation(Number.MAX_SAFE_INTEGER)).toThrow(/filesystem|allocation/i);
      allocation.updateUsed(900);
      expect(() => allocation.setAllocation(899)).toThrow(/usage/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed on corrupt, malformed, or impossible persistence", async () => {
    const root = await dir();
    try {
      const path = join(root, "allocation.json");
      await writeFile(path, "{broken", { mode: 0o600 });
      expect(() => createCapacityAllocation(root, undefined, path)).toThrow(/corrupt/i);
      await writeFile(path, JSON.stringify({ version: 1, allocationBytes: 10, usedBytes: 20, reservedBytes: 0, physicalBytes: 10, usableBytes: 10 }));
      expect(() => createCapacityAllocation(root, undefined, path)).toThrow(/impossible/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects filesystem/stat failures and exposes sanitized bounded state", async () => {
    const root = await dir();
    try {
      expect(() => createCapacityAllocation(join(root, "missing"), 10)).toThrow(/filesystem capacity unavailable/i);
      const allocation = createCapacityAllocation(root, 1024);
      expect(JSON.stringify(allocation.state())).not.toMatch(/password|private|secret|plaintext|piece/i);
      expect(JSON.stringify(allocation.state()).length).toBeLessThan(1000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves allocation through a real storage-node restart", async () => {
    const root = await dir();
    try {
      const { createStorageNode } = await import("./index.js");
      const allocationPath = join(root, "allocation-state.json");
      const first = createStorageNode({ storageDir: root, capacityBytes: 2048, allocationPath });
      await first.listen(0);
      expect((await first.getCapacity()).allocatedBytes).toBe(2048);
      await first.close();
      const second = createStorageNode({ storageDir: root, capacityBytes: 2048, allocationPath });
      await second.listen(0);
      expect((await second.getCapacity()).allocatedBytes).toBe(2048);
      await second.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
