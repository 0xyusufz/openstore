import { describe, expect, it, vi } from "vitest";
import { coordinatorNodesToEndpoints, createCoordinatorAdapter, CoordinatorDiscoveryError, resolveEndpoints } from "./coordinator.js";
import { createIdentity } from "../../packages/identity/index.js";
import { peerIdFromOpenStorePublicKey } from "../../packages/p2p/identity-binding.js";

const node = (id: string, transport: "http" | "libp2p" = "http") => ({
  nodeId: id,
  publicKey: createIdentity().publicKey.toString("base64"),
  baseUrl: transport === "http" ? `http://127.0.0.1/${id}` : `libp2p://${id}`,
  available: true,
  lastSeen: Date.now(),
  capacity: { allocatedBytes: 1000, usedBytes: 100, availableBytes: 900 },
  reliability: {
    successfulHeartbeats: 2, missedHeartbeats: 0, score: 83,
    successfulAudits: 3, failedAudits: 1, storageScore: 75,
  },
  ...(transport === "libp2p" ? (() => {
    const identity = createIdentity();
    const peerId = peerIdFromOpenStorePublicKey(identity.publicKey);
    return {
    nodeId: peerId,
    publicKey: identity.publicKey.toString("base64"),
    transport,
    baseUrl: `libp2p://${peerId}`,
    multiaddr: `/ip4/127.0.0.1/tcp/4001/p2p/${peerId}`,
    identityBinding: peerId,
    capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, maxPieceBytes: 500 },
    };
  })() : {}),
});

describe("coordinator endpoint adapter (Milestone 042)", () => {
  it("strictly converts mixed nodes and preserves routing metadata", () => {
    const endpoints = coordinatorNodesToEndpoints({
      nodes: [node("http-a"), node("peer-a", "libp2p"), { ...node("offline"), available: false }],
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toMatchObject({
      id: "http-a", transport: "http", baseUrl: "http://127.0.0.1/http-a",
      capacity: { usedBytes: 100, availableBytes: 900 }, reliabilityScore: 83, storageScore: 75,
    });
    expect(endpoints[1]).toMatchObject({
      transport: "libp2p", multiaddr: expect.stringContaining("/p2p/"),
      identityBinding: expect.any(String), identity: { publicKey: expect.any(String) },
      capabilities: { maxPieceBytes: 500 },
    });
  });

  it("coalesces refreshes and keeps the last good snapshot after failure", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error("coordinator offline");
      return new Response(JSON.stringify({ nodes: [node("stable")] }), { status: 200 });
    });
    const adapter = createCoordinatorAdapter({ baseUrl: "http://coordinator.test/", fetch });
    const [first, second] = await Promise.all([adapter.refresh(), adapter.refresh()]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(adapter.refresh()).rejects.toThrow("coordinator offline");
    expect(adapter.getEndpoints()).toEqual(first);
    expect(adapter.lastError?.message).toBe("coordinator offline");
    expect(await adapter.refreshSafe()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed records without poisoning the snapshot", async () => {
    expect(() => coordinatorNodesToEndpoints({ nodes: [{ ...node("bad"), capacity: { usedBytes: -1, availableBytes: 1 } }] }))
      .toThrow(/capacity\.usedBytes/);
  });

  it("rejects duplicate identities and transport downgrades", () => {
    const first = node("duplicate");
    expect(() => coordinatorNodesToEndpoints({ nodes: [first, { ...first }] }))
      .toThrow(/duplicate coordinator node identity/);
    expect(() => coordinatorNodesToEndpoints({
      nodes: [{ ...node("peer", "libp2p"), baseUrl: "http://127.0.0.1:1" }],
    })).toThrow(/libp2p baseUrl/);
  });

  it("tracks fresh to cached/stale and rejects placement without fresh data", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error("offline");
      return new Response(JSON.stringify({ nodes: [node("stable")] }), { status: 200 });
    });
    const adapter = createCoordinatorAdapter({
      baseUrl: "http://coordinator.test",
      fetch,
      freshness: { freshMaxAgeMs: 10, staleAfterMs: 20 },
    });
    await adapter.refresh();
    expect(adapter.discovery.freshness).toBe("fresh");
    await expect(adapter.refresh()).rejects.toThrow("offline");
    expect(["cached", "stale"]).toContain(adapter.discovery.freshness);
    await expect(resolveEndpoints([], adapter, { requireFresh: true })).rejects.toBeInstanceOf(CoordinatorDiscoveryError);
    expect(adapter.getKnownEndpoints()).toHaveLength(1);
  });

  it("rejects invalid freshness configuration", () => {
    expect(() => createCoordinatorAdapter({ baseUrl: "http://coordinator.test", freshness: { freshMaxAgeMs: 0 } })).toThrow();
  });
});
