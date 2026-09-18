import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderAllocationLifecycle } from "./provider-allocation-lifecycle.js";

describe("provider allocation lifecycle", () => {
  it("persists drain and enforces safe release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-059a-lifecycle-"));
    const path = join(dir, "lifecycle.json");
    try {
      const first = createProviderAllocationLifecycle(path);
      expect(first.inspect().state).toBe("sharing");
      expect(first.stopSharing().state).toBe("draining");
      expect(createProviderAllocationLifecycle(path).inspect().state).toBe("draining");
      expect(() => first.release(1, 0)).toThrow(/pieces|reservations/i);
      expect(first.release(0, 0).state).toBe("released");
      expect(() => first.startSharing()).toThrow(/released|transition/i);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed for corrupt or invalid state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-059a-corrupt-"));
    const path = join(dir, "lifecycle.json");
    try {
      await writeFile(path, "{bad");
      expect(() => createProviderAllocationLifecycle(path)).toThrow(/corrupt/i);
      await writeFile(path, JSON.stringify({ version: 1, state: "transitioning", updatedAt: Date.now() }));
      expect(() => createProviderAllocationLifecycle(path)).toThrow(/invalid/i);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("allows only draining to resume and keeps release irreversible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-060a-transition-"));
    const path = join(dir, "lifecycle.json");
    try {
      const lifecycle = createProviderAllocationLifecycle(path);
      expect(() => lifecycle.startSharing()).toThrow(/transition/i);
      expect(lifecycle.stopSharing().state).toBe("draining");
      expect(lifecycle.startSharing().state).toBe("sharing");
      expect(() => lifecycle.startSharing()).toThrow(/transition/i);
      expect(lifecycle.stopSharing().state).toBe("draining");
      expect(lifecycle.release(0, 0).state).toBe("released");
      expect(() => lifecycle.startSharing()).toThrow(/released|transition/i);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
