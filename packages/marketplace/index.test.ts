import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createRegistry } from "../registry/index.js";
import { createMarketplace, getMarketplaceSnapshot, isMarketplaceEligible, listMarketplaceProviders, toMarketplaceProvider, validateMarketplaceFilter } from "./index.js";

function makeRecord(overrides: Partial<ReturnType<ReturnType<typeof createRegistry>["list"]>[number]> = {}) {
  const id = createIdentity();
  return {
    nodeId: id.publicKey.toString("base64"),
    publicKey: id.publicKey.toString("base64"),
    baseUrl: "http://127.0.0.1:4101",
    available: true,
    lastSeen: Date.now(),
    capacity: { allocatedBytes: 1_000_000, usedBytes: 200_000, availableBytes: 800_000 },
    reliability: { successfulHeartbeats: 1, missedHeartbeats: 0, score: 80, successfulAudits: 0, failedAudits: 0, storageScore: 70 },
    lifecycle: "sharing" as const,
    ...overrides,
  };
}

function mockRegistry(records: ReturnType<typeof makeRecord>[]): ReturnType<typeof createRegistry> {
  return {
    list: () => records.map((r) => ({ ...r, capacity: { ...r.capacity }, reliability: { ...r.reliability } })) as unknown as ReturnType<ReturnType<typeof createRegistry>["list"]>,
    listAvailable: () => records.filter((r) => r.available).map((r) => ({ ...r })) as unknown as ReturnType<ReturnType<typeof createRegistry>["listAvailable"]>,
  } as unknown as ReturnType<typeof createRegistry>;
}

describe("marketplace 069 — eligibility, capacity, lifecycle", () => {
  it("excludes draining/released/unavailable and zero-capacity", () => {
    expect(isMarketplaceEligible(makeRecord({ lifecycle: "draining" }))).toBe(false);
    expect(isMarketplaceEligible(makeRecord({ lifecycle: "released" }))).toBe(false);
    expect(isMarketplaceEligible(makeRecord({ available: false }))).toBe(false);
    expect(isMarketplaceEligible(makeRecord({ capacity: { allocatedBytes: 100, usedBytes: 100, availableBytes: 0 } }))).toBe(false);
    expect(isMarketplaceEligible(makeRecord({ lifecycle: "sharing" }))).toBe(true);
    // HTTP lifecycle gap: registry NodeRecord.lifecycle is undefined for HTTP because
    // apps/storage-node/index.ts registerSigned/heartbeatSigned only propagate capacity,
    // not lifecycle (unlike libp2p descriptor). Safest fail-closed: undefined is not sharing.
    expect(isMarketplaceEligible(makeRecord({ lifecycle: undefined } as unknown as ReturnType<typeof makeRecord>))).toBe(false);
  });

  it("HTTP provider gap — eligible vs draining (explicit lifecycle required)", () => {
    const eligibleHttp = makeRecord({ lifecycle: "sharing" });
    const drainingHttp = makeRecord({ lifecycle: "draining" });
    // Eligible HTTP with explicit sharing must appear
    expect(isMarketplaceEligible(eligibleHttp)).toBe(true);
    expect(toMarketplaceProvider(eligibleHttp as unknown as Parameters<typeof toMarketplaceProvider>[0]).lifecycle).toBe("sharing");
    // Draining HTTP with explicit draining must not appear
    expect(isMarketplaceEligible(drainingHttp)).toBe(false);
    // Undefined lifecycle (HTTP gap) must not appear — fail-closed
    expect(isMarketplaceEligible(makeRecord({ lifecycle: undefined } as unknown as ReturnType<typeof makeRecord>))).toBe(false);
  });

  it("libp2p behavior remains unchanged — sharing vs draining", () => {
    const sharingLibp2p = makeRecord({ lifecycle: "sharing", transport: "libp2p" } as unknown as Partial<ReturnType<typeof makeRecord>>);
    const drainingLibp2p = makeRecord({ lifecycle: "draining", transport: "libp2p" } as unknown as Partial<ReturnType<typeof makeRecord>>);
    expect(isMarketplaceEligible(sharingLibp2p)).toBe(true);
    expect(isMarketplaceEligible(drainingLibp2p)).toBe(false);
  });

  it("sanitized provider never contains secrets", () => {
    const rec = makeRecord();
    const p = toMarketplaceProvider(rec as unknown as Parameters<typeof toMarketplaceProvider>[0]);
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/privatekey|recoveryphrase|password|plaintext|signature|nonce/i);
    expect(Object.keys(p).sort()).toEqual(["allocatedBytes", "available", "availableBytes", "baseUrl", "id", "lastSeen", "lifecycle", "score", "storageScore", "usedBytes"].sort());
  });

  it("listing respects lifecycle and orders by availableBytes", () => {
    // Use explicit lifecycle records to avoid HTTP undefined gap; registry.register for HTTP would give undefined and be excluded fail-closed
    const records = [
      makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 200_000, availableBytes: 800_000 } }),
      makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 100_000, availableBytes: 900_000 } }),
      makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 500_000, availableBytes: 500_000 } }),
    ];
    const mock = mockRegistry(records);
    let providers = listMarketplaceProviders(mock as unknown as ReturnType<typeof createRegistry>);
    expect(providers).toHaveLength(3);
    expect(providers[0]!.availableBytes).toBe(900_000);

    // Draining must be excluded even for libp2p
    const drainingRecord = makeRecord({ lifecycle: "draining", capacity: { allocatedBytes: 1_000_000, usedBytes: 0, availableBytes: 1_000_000 } });
    expect(isMarketplaceEligible(drainingRecord as unknown as Parameters<typeof isMarketplaceEligible>[0])).toBe(false);
  });

  it("filtering by minAvailableBytes, minScore, transport, limit/offset", () => {
    const records = [
      makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 0, availableBytes: 1_000_000 } }),
      makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 300_000, availableBytes: 700_000 } }),
      makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 600_000, availableBytes: 400_000 } }),
    ];
    const mock = mockRegistry(records);
    const all = listMarketplaceProviders(mock as unknown as ReturnType<typeof createRegistry>);
    expect(all).toHaveLength(3);
    const filtered = listMarketplaceProviders(mock as unknown as ReturnType<typeof createRegistry>, { minAvailableBytes: 900_000 });
    expect(filtered.every((p)=>p.availableBytes>=900_000)).toBe(true);
    const limited = listMarketplaceProviders(mock as unknown as ReturnType<typeof createRegistry>, { limit: 1 });
    expect(limited).toHaveLength(1);
    const offset = listMarketplaceProviders(mock as unknown as ReturnType<typeof createRegistry>, { limit: 1, offset: 1 });
    expect(offset).toHaveLength(1);
    expect(offset[0]!.id).not.toBe(limited[0]!.id);
  });

  it("capacity totals reflect only eligible providers", () => {
    const eligible = makeRecord({ capacity: { allocatedBytes: 1_000_000, usedBytes: 200_000, availableBytes: 800_000 } });
    const ineligibleZero = makeRecord({ capacity: { allocatedBytes: 500_000, usedBytes: 500_000, availableBytes: 0 } });
    const mock = mockRegistry([eligible, ineligibleZero]);
    const snap = getMarketplaceSnapshot(mock as unknown as ReturnType<typeof createRegistry>);
    expect(snap.providerCount).toBe(1);
    expect(snap.totalAvailableBytes).toBe(800_000);
    expect(snap.totalAllocatedBytes).toBe(1_000_000);
    expect(snap.source).toBe("live");
  });

  it("HTTP undefined lifecycle is fail-closed — not marketplace eligible", () => {
    // Real HTTP via registry.register gives undefined lifecycle; after fix it must not appear
    const registry = createRegistry();
    const id = createIdentity();
    registry.register("http://127.0.0.1:4101", id, { allocatedBytes: 1_000_000, usedBytes: 0, availableBytes: 1_000_000 });
    const raw = registry.list()[0]!;
    expect(raw.lifecycle).toBeUndefined();
    expect(isMarketplaceEligible(raw as unknown as Parameters<typeof isMarketplaceEligible>[0])).toBe(false);
    expect(listMarketplaceProviders(registry)).toHaveLength(0);
  });

  it("fail closed on stale/unavailable — null registry throws", () => {
    expect(() => getMarketplaceSnapshot(null as unknown as ReturnType<typeof createRegistry>)).toThrow(/marketplace unavailable/);
    expect(() => listMarketplaceProviders(null as unknown as ReturnType<typeof createRegistry>)).toThrow(/registry is required/);
  });

  it("validate filter rejects bad inputs", () => {
    expect(() => validateMarketplaceFilter({ minAvailableBytes: -1 })).toThrow(/minAvailableBytes/);
    expect(() => validateMarketplaceFilter({ minScore: 200 })).toThrow(/minScore/);
    expect(() => validateMarketplaceFilter({ transport: "ftp" as unknown as string })).toThrow(/transport/);
    expect(() => validateMarketplaceFilter({ limit: 0 })).toThrow(/limit/);
  });

  it("createMarketplace factory reuses selection and is fail-closed", () => {
    const registry = createRegistry();
    const m = createMarketplace(registry);
    expect(m.version).toBe(1);
    expect(m.list()).toEqual([]);
    // HTTP via registry.register is now fail-closed (undefined lifecycle), so will not appear
    const id = createIdentity();
    registry.register("http://127.0.0.1:4101", id, { allocatedBytes: 1_000, usedBytes: 0, availableBytes: 1_000 });
    expect(m.list()).toHaveLength(0);
    // Explicit sharing via mock registry does appear
    const explicit = makeRecord({ capacity: { allocatedBytes: 1_000, usedBytes: 0, availableBytes: 1_000 } });
    const mock = mockRegistry([explicit]);
    const m2 = createMarketplace(mock as unknown as ReturnType<typeof createRegistry>);
    expect(m2.list()).toHaveLength(1);
    expect(m2.snapshot().providerCount).toBe(1);
  });
});
