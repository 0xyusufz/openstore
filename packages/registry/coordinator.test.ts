import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createRegistry } from "./index.js";
import { DEFAULT_REGISTRY_COORDINATOR_PORT, createRegistryClient, createRegistryCoordinator } from "./coordinator.js";
import { peerIdFromOpenStorePublicKey } from "../p2p/identity-binding.js";
import { EventStore } from "../events/index.js";

describe("cross-process registry coordinator", () => {
  it("registers, heartbeats, lists and removes nodes over HTTP", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(DEFAULT_REGISTRY_COORDINATOR_PORT);
    expect(DEFAULT_REGISTRY_COORDINATOR_PORT).toBe(4190);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "secret" });
    const identity = createIdentity();
    const node = await client.registerWithIdentity(identity, "http://127.0.0.1:4901");
    expect(node.nodeId).toBe(identity.publicKey.toString("base64"));
    expect((await client.nodes())).toHaveLength(1);
    expect((await client.heartbeatWithIdentity(identity, node.nodeId)).available).toBe(true);
    await client.unregisterWithIdentity(identity, node.nodeId);
    expect(await client.nodes()).toHaveLength(0);
    await coordinator.close();
  });

  it("uses bearer authentication and reports connection failures", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const unauthorized = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "wrong" });
    await expect(unauthorized.nodes()).rejects.toThrow("unauthorized");
    await coordinator.close();

    const unavailable = createRegistryClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(unavailable.nodes()).rejects.toMatchObject({ operation: "nodes", classification: "transient" });
  });

  it("exposes readiness without credentials and reports registry durability state", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ready", persistence: { healthy: true } });
    await coordinator.close();
  });

  it("requires credentials for metrics while readiness stays public", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    // Unauthenticated metrics access is rejected (operational disclosure).
    expect((await fetch(`http://127.0.0.1:${port}/v1/metrics`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/v1/metrics`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${port}/v1/metrics`, { headers: { authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { counters: unknown[]; gauges: unknown[]; histograms: unknown[] };
    expect(body.counters).toBeInstanceOf(Array);
    expect(JSON.stringify(body)).not.toMatch(/secret|private|recovery|plaintext|ciphertext|piece-[A-Za-z0-9]/i);
    await coordinator.close();
  });

  it("exposes bounded authenticated operational events", async () => {
    const events = new EventStore(10);
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret", events });
    const port = await coordinator.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/v1/events`)).status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "coordinator.started", version: 1 })]));
    await coordinator.close();
  });

  it("exposes aggregate conditions without changing readiness", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/conditions`, { headers: { authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { protocol: number; conditions: Array<{ id: string; active: boolean }>; events: unknown[] };
    expect(body.protocol).toBe(1);
    expect(body.conditions.some((condition) => condition.id === "coordinator-no-available-nodes" && condition.active)).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(100);
    await coordinator.close();
  });

  it("exposes safe coordinator discovery diagnostics", async () => {
    const coordinator = createRegistryCoordinator({
      registry: createRegistry(),
      discovery: () => ({ state: "stale", ageMs: 5000, endpointCount: 2, freshAvailable: false }),
    });
    const port = await coordinator.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`);
    expect(response.status).toBe(200);
    const body = await response.json() as { discovery?: Record<string, unknown>; conditions: Array<{ id: string; active: boolean }> };
    expect(body.discovery).toEqual({ state: "stale", ageMs: 5000, endpointCount: 2, freshAvailable: false });
    expect(body.conditions.some((condition) => condition.id === "coordinator-discovery-stale" && condition.active)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/https?:|node-id|piece|filename|path|token/i);
    await coordinator.close();
  });

  it("exposes safe persistence status and contextual client errors", async () => {
    const events: string[] = [];
    const coordinator = createRegistryCoordinator({
      registry: createRegistry({ onEvent: (event) => events.push(event.type) }),
      token: "secret",
      onEvent: (event) => events.push(event.type),
    });
    const port = await coordinator.listen(0);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "secret" });
    await expect(client.status()).resolves.toMatchObject({ status: "ok", persistence: { enabled: false, healthy: true } });
    await coordinator.close();
    expect(events).toContain("coordinator.started");
    expect(events).toContain("coordinator.closed");
    expect(events).not.toContain("secret");
    await expect(client.nodes()).rejects.toMatchObject({ operation: "nodes", classification: "transient" });
  });

  it("does not allow an untrusted process to use the coordinator", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/nodes`);
    expect(response.status).toBe(401);
    await coordinator.close();
  });

  it("authenticates libp2p descriptor registration and preserves placement metadata", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "secret" });
    const identity = createIdentity();
    const peerId = peerIdFromOpenStorePublicKey(identity.publicKey);
    const descriptor = {
      nodeId: peerId, baseUrl: `libp2p://${peerId}`,
      multiaddr: `/ip4/127.0.0.1/tcp/4101/p2p/${peerId}`,
      identity: { publicKey: identity.publicKey.toString("base64") }, identityBinding: peerId,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, allocatedBytes: 100, availableBytes: 100 },
    };
    const capacity = { allocatedBytes: 100, usedBytes: 0, availableBytes: 100 };
    const record = await client.registerLibp2pWithIdentity(identity, descriptor, capacity);
    expect(record.transport).toBe("libp2p");
    expect((await client.nodes())[0].multiaddr).toBe(descriptor.multiaddr);
    await client.heartbeatLibp2pWithIdentity(identity, descriptor, capacity);
    await client.unregisterWithIdentity(identity, peerId);
    expect(await client.nodes()).toHaveLength(0);
    await coordinator.close();
  });
});
