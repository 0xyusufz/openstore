import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../identity/index.js";
import {
  createRegistry,
  computeReliabilityScore,
  DEFAULT_RELIABILITY_SCORE,
  type NodeRecord,
} from "./index.js";
import { selectNodes } from "../../apps/client/selection.js";

function makeRecord(nodeId: string, availableBytes: number, score: number): NodeRecord {
  return {
    nodeId,
    publicKey: nodeId,
    baseUrl: `http://${nodeId}:4000`,
    available: true,
    lastSeen: Date.now(),
    capacity: { allocatedBytes: 1000, totalBytes: 1000, usedBytes: 1000 - availableBytes, availableBytes },
    reliability: { successfulHeartbeats: 0, missedHeartbeats: 0, score, successfulAudits: 0, failedAudits: 0, storageScore: 50 },
  };
}

describe("node reliability & health scoring (OPENSTORE-016)", () => {
  it("1. new node gets default reliability", () => {
    const registry = createRegistry();
    const id = createIdentity();
    const rec = registry.register("http://127.0.0.1:4101", id);
    expect(rec.reliability).toBeDefined();
    expect(rec.reliability.successfulHeartbeats).toBe(0);
    expect(rec.reliability.missedHeartbeats).toBe(0);
    expect(rec.reliability.score).toBe(DEFAULT_RELIABILITY_SCORE);
    // Also exposed via discovery metadata
    const listed = registry.listAvailable()[0];
    expect(listed?.reliability.score).toBe(DEFAULT_RELIABILITY_SCORE);
    const fetched = registry.get(id.publicKey.toString("base64"));
    expect(fetched?.reliability.score).toBe(DEFAULT_RELIABILITY_SCORE);
    const endpoints = registry.getAvailableEndpoints();
    expect(endpoints[0]?.reliabilityScore).toBe(DEFAULT_RELIABILITY_SCORE);
  });

  it("2. successful heartbeat updates reliability", () => {
    const registry = createRegistry();
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    registry.register("http://127.0.0.1:4102", id);
    const before = registry.get(nodeId)?.reliability.score as number;
    expect(before).toBe(DEFAULT_RELIABILITY_SCORE);
    const after1 = registry.heartbeat(nodeId, id);
    expect(after1.reliability.successfulHeartbeats).toBe(1);
    expect(after1.reliability.score).toBeGreaterThan(before);
    const after2 = registry.heartbeat(nodeId, id);
    expect(after2.reliability.successfulHeartbeats).toBe(2);
    expect(after2.reliability.score).toBeGreaterThanOrEqual(after1.reliability.score);
    // Score matches deterministic formula
    expect(after2.reliability.score).toBe(
      computeReliabilityScore(after2.reliability.successfulHeartbeats, after2.reliability.missedHeartbeats),
    );
  });

  it("3. missed/expired heartbeat reduces reliability", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 50, maxClockSkewMs: 5000 });
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    registry.register("http://127.0.0.1:4103", id);
    // Build up some successes first
    registry.heartbeat(nodeId, id);
    registry.heartbeat(nodeId, id);
    const peak = registry.get(nodeId)?.reliability.score as number;
    expect(peak).toBeGreaterThan(DEFAULT_RELIABILITY_SCORE);
    // Let it expire
    await new Promise((r) => setTimeout(r, 80));
    const expired = registry.get(nodeId);
    expect(expired?.available).toBe(false);
    expect(expired?.reliability.missedHeartbeats).toBe(1);
    expect(expired?.reliability.score).toBeLessThan(peak);
    // Repeated reads while still expired must not add more misses (no arbitrary drift)
    const misses = expired?.reliability.missedHeartbeats;
    registry.list();
    registry.listAvailable();
    registry.get(nodeId);
    const again = registry.get(nodeId);
    expect(again?.reliability.missedHeartbeats).toBe(misses);
    expect(again?.reliability.score).toBe(expired?.reliability.score);
    // Heartbeat revives and improves again
    const revived = registry.heartbeat(nodeId, id);
    expect(revived.available).toBe(true);
    expect(revived.reliability.score).toBeGreaterThan(expired?.reliability.score as number);
  });

  it("4. score remains within 0–100", () => {
    // Extreme counters via formula
    expect(computeReliabilityScore(0, 0)).toBeGreaterThanOrEqual(0);
    expect(computeReliabilityScore(0, 0)).toBeLessThanOrEqual(100);
    expect(computeReliabilityScore(10_000, 0)).toBeLessThanOrEqual(100);
    expect(computeReliabilityScore(0, 10_000)).toBeGreaterThanOrEqual(0);
    // Many misses then many successes via registry
    const registry = createRegistry({ heartbeatTimeoutMs: 30, maxClockSkewMs: 5000 });
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    registry.register("http://127.0.0.1:4104", id);
    for (let i = 0; i < 50; i++) {
      registry.heartbeat(nodeId, id);
      const s = registry.get(nodeId)?.reliability.score as number;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it("5. identical event sequence produces deterministic score", async () => {
    async function runSequence(): Promise<number> {
      const registry = createRegistry({ heartbeatTimeoutMs: 40, maxClockSkewMs: 5000 });
      const id = createIdentity();
      const nodeId = id.publicKey.toString("base64");
      registry.register("http://127.0.0.1:4105", id);
      registry.heartbeat(nodeId, id);
      registry.heartbeat(nodeId, id);
      await new Promise((r) => setTimeout(r, 60));
      registry.get(nodeId); // triggers single miss
      registry.heartbeat(nodeId, id);
      return registry.get(nodeId)?.reliability.score as number;
    }
    const a = await runSequence();
    const b = await runSequence();
    expect(a).toBe(b);
    // Pure formula determinism
    expect(computeReliabilityScore(3, 1)).toBe(computeReliabilityScore(3, 1));
  });

  it("6. node selection prefers higher reliability when capacity is otherwise equal", () => {
    const candidates = [
      makeRecord("low-rel", 500, 20),
      makeRecord("high-rel", 500, 90),
      makeRecord("mid-rel", 500, 50),
    ];
    const selected = selectNodes(candidates, 100, 3);
    expect(selected.map((n) => n.nodeId)).toEqual(["high-rel", "mid-rel", "low-rel"]);
    // Capacity still dominates: bigger capacity wins even with lower reliability
    const mixed = [makeRecord("big-low", 900, 10), makeRecord("small-high", 500, 99)];
    const sel2 = selectNodes(mixed, 100, 2);
    expect(sel2[0]?.nodeId).toBe("big-low");
  });

  it("7. persistence preserves reliability state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg-rel-"));
    const file = join(dir, "registry.json");
    const reg1 = createRegistry({ persistencePath: file });
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    reg1.register("http://127.0.0.1:4106", id);
    reg1.heartbeat(nodeId, id);
    reg1.heartbeat(nodeId, id);
    const before = reg1.get(nodeId)?.reliability;
    expect(before?.successfulHeartbeats).toBe(2);

    const reg2 = createRegistry({ persistencePath: file });
    const after = reg2.get(nodeId)?.reliability;
    expect(after).toEqual(before);

    // No sensitive data persisted
    const content = await readFile(file, "utf8");
    expect(content.toLowerCase()).not.toContain("privatekey");
    expect(content.toLowerCase()).not.toContain("recoveryphrase");
    expect(content.toLowerCase()).not.toContain("signature");
    expect(content).not.toContain(id.privateKey.toString("base64"));
    await rm(dir, { recursive: true, force: true });
  });
});
