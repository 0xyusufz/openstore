import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "../storage-node/index.js";
import { selectNodes, selectEndpoints, storePieceWithSelection } from "./selection.js";
import { storePieceOnNodes } from "./index.js";
import type { NodeRecord } from "../../packages/registry/index.js";

function makeRecord(nodeId: string, available: boolean, availableBytes: number, totalBytes = 1000, reliabilityScore = 50): NodeRecord {
  return {
    nodeId,
    publicKey: nodeId,
    baseUrl: `http://${nodeId}:4000`,
    available,
    lastSeen: Date.now(),
    capacity: { totalBytes, usedBytes: totalBytes - availableBytes, availableBytes },
    reliability: { successfulHeartbeats: 0, missedHeartbeats: 0, score: reliabilityScore, successfulAudits: 0, failedAudits: 0, storageScore: 50 },
  };
}

describe("intelligent node selection (OPENSTORE-013)", () => {
  it("1. unavailable node is excluded", () => {
    const candidates = [
      makeRecord("node-a", true, 500),
      makeRecord("node-b", false, 1000),
      makeRecord("node-c", true, 300),
    ];
    const selected = selectNodes(candidates, 100, 2);
    expect(selected.map((n) => n.nodeId)).not.toContain("node-b");
    expect(selected).toHaveLength(2);
  });

  it("2. insufficient-capacity node is excluded", () => {
    const candidates = [
      makeRecord("big", true, 1000),
      makeRecord("small", true, 10),
      makeRecord("medium", true, 500),
    ];
    const selected = selectNodes(candidates, 100, 2);
    expect(selected.map((n) => n.nodeId)).not.toContain("small");
    expect(selected).toHaveLength(2);
  });

  it("3. higher-capacity suitable nodes are preferred", () => {
    const candidates = [
      makeRecord("low", true, 100),
      makeRecord("mid", true, 500),
      makeRecord("high", true, 900),
    ];
    const selected = selectNodes(candidates, 50, 2);
    expect(selected[0]?.nodeId).toBe("high");
    expect(selected[1]?.nodeId).toBe("mid");
  });

  it("4. requested replication factor is respected", () => {
    const candidates = [
      makeRecord("a", true, 1000),
      makeRecord("b", true, 800),
      makeRecord("c", true, 600),
      makeRecord("d", true, 400),
    ];
    expect(selectNodes(candidates, 100, 1)).toHaveLength(1);
    expect(selectNodes(candidates, 100, 2)).toHaveLength(2);
    expect(selectNodes(candidates, 100, 3)).toHaveLength(3);
  });

  it("5. insufficient suitable nodes fails clearly", () => {
    const candidates = [
      makeRecord("only-one", true, 1000),
      makeRecord("unavailable", false, 2000),
      makeRecord("tiny", true, 5),
    ];
    expect(() => selectNodes(candidates, 100, 2)).toThrow(/insufficient suitable nodes/i);
    expect(() => selectNodes(candidates, 5000, 1)).toThrow(/insufficient suitable nodes/i);
  });

  it("6. selected nodes are unique", () => {
    const candidates = [
      makeRecord("a", true, 1000),
      makeRecord("b", true, 900),
      makeRecord("c", true, 800),
    ];
    const selected = selectNodes(candidates, 10, 3);
    const ids = selected.map((n) => n.nodeId);
    expect(new Set(ids).size).toBe(3);
  });

  it("7. existing manual endpoint storage still works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-sel-manual-"));
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    const manual = { id: "manual-sel", baseUrl: `http://127.0.0.1:${port}` };
    // Backward compat: storePieceOnNodes still uses first N without selection
    const data = Buffer.from("manual-selection-works");
    const report = await storePieceOnNodes("sel-manual-piece", data, [manual]);
    expect(report.succeeded).toHaveLength(1);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("8. selection via registry and upload integration", async () => {
    const registry = createRegistry();
    const ids = [createIdentity(), createIdentity(), createIdentity()];
    // Register 3 nodes with varying capacity
    const capacities = [100, 500, 1000];
    for (let i = 0; i < ids.length; i++) {
      const cap = { totalBytes: 2000, usedBytes: 2000 - capacities[i]!, availableBytes: capacities[i]! };
      registry.register(`http://127.0.0.1:${4100 + i}`, ids[i]!, cap);
    }
    // Piece size 400 should exclude node with 100 available, prefer 1000 then 500
    const selected = selectNodes(registry.listAvailable(), 400, 2);
    expect(selected.map((n) => n.capacity.availableBytes).sort((a, b) => b - a)).toEqual([1000, 500]);

    // Also test selectEndpoints
    const endpoints = selectEndpoints(registry, 400, 1);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.id).toBe(ids[2]?.publicKey.toString("base64"));

    // Test storePieceWithSelection using registry with real nodes and capacity
    const realDirs = await Promise.all(ids.map(() => mkdtemp(join(tmpdir(), "openstore-sel-real-"))));
    const realRegistry = createRegistry();
    const realNodes: import("../storage-node/index.js").StorageNode[] = [];
    for (let i = 0; i < ids.length; i++) {
      const n = createStorageNode({
        storageDir: realDirs[i] as string,
        identity: ids[i]!,
        registry: realRegistry,
        capacityBytes: 2000,
        registryHeartbeatIntervalMs: 30,
      });

      await n.listen(0, "127.0.0.1");
      realNodes.push(n);
    }
    // Fill first node to have low available (simulate used)
    const firstNode = realNodes[0] as import("../storage-node/index.js").StorageNode;
    const firstBaseUrl = `http://127.0.0.1:${(firstNode.server.address() as { port: number }).port}`;
    await fetch(`${firstBaseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "fill", data: Buffer.alloc(1900).toString("base64") }),
    });
    // Wait for heartbeat to update registry capacity
    await new Promise((r) => setTimeout(r, 150));
    const available = realRegistry.listAvailable();
    const low = available.find((r) => r.capacity.availableBytes < 200);
    expect(low).toBeDefined();

    const bigPiece = Buffer.alloc(500);
    const report = await storePieceWithSelection("sel-big-piece", bigPiece, realRegistry, [], { replicationFactor: 2 });
    expect(report.succeeded.length).toBe(2);
    expect(report.succeeded.every((e) => e.id !== low?.nodeId)).toBe(true);

    for (const n of realNodes) await n.close();
    for (const d of realDirs) await rm(d, { recursive: true, force: true });
  });

  it("rejects invalid or overflowing capacity instead of treating it as available", () => {
    const valid = makeRecord("valid", true, 100, 100);
    expect(selectNodes([valid], 100, 1)).toHaveLength(1);
    expect(() => selectNodes([makeRecord("insufficient", true, 99)], 100, 1)).toThrow(/insufficient/i);
    expect(() => selectNodes([{ ...valid, capacity: { allocatedBytes: 100, usedBytes: 80, availableBytes: 30 } }], 1, 1)).toThrow(/insufficient/i);
    expect(() => selectNodes([{ ...valid, capacity: { allocatedBytes: Number.MAX_SAFE_INTEGER, usedBytes: Number.MAX_SAFE_INTEGER, availableBytes: 1 } }], 1, 1)).toThrow(/insufficient/i);
    expect(() => selectNodes([{ ...valid, available: false }], 1, 1)).toThrow(/insufficient/i);
  });
});
