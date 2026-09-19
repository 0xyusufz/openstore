import { describe, expect, it } from "vitest";
import { BYTES_PER_GIB, MS_PER_HOUR, createEconomics } from "./index.js";
import { createIdentity } from "../identity/index.js";

function makeRecord(lifecycle: "sharing" | "draining" | "released" | undefined = "sharing", allocatedBytes = BYTES_PER_GIB) {
  const id = createIdentity();
  return {
    nodeId: id.publicKey.toString("base64"),
    publicKey: id.publicKey.toString("base64"),
    baseUrl: "http://127.0.0.1:4101",
    available: true,
    lastSeen: Date.now(),
    capacity: { allocatedBytes, usedBytes: 0, availableBytes: allocatedBytes },
    reliability: { successfulHeartbeats: 1, missedHeartbeats: 0, score: 80, successfulAudits: 0, failedAudits: 0, storageScore: 70 },
    lifecycle,
  } as unknown as import("../registry/index.js").NodeRecord;
}

describe("economics 070 hardening — idempotent provider earnings", () => {
  it("identical provider contribution submitted twice => one economic credit event", () => {
    const e = createEconomics({ now: () => 1000 });
    e.createAccount("prov1");
    const rec = makeRecord("sharing");
    const first = e.recordProviderContribution("prov1", rec, MS_PER_HOUR, "period-2025-01-01");
    expect(first.credits).toBe(1);
    expect(first.entry).not.toBeNull();
    expect(e.getBalance("prov1")).toBe(1);
    expect(e.getLedger("prov1")).toHaveLength(1);
    expect(e.getTotalSupply()).toBe(1);

    const second = e.recordProviderContribution("prov1", rec, MS_PER_HOUR, "period-2025-01-01");
    expect(second.credits).toBe(0);
    expect(second.entry).toBeNull();
    expect(e.getBalance("prov1")).toBe(1);
    expect(e.getTotalSupply()).toBe(1);
    expect(e.getLedger("prov1")).toHaveLength(1);
    // No duplicate ledger id
    expect(e.getLedger()[0]!.id).toBe(1);
  });

  it("identical without explicit eventId — auto-derived key also idempotent", () => {
    const e = createEconomics({ now: () => 2000 });
    e.createAccount("prov2");
    const rec = makeRecord("sharing");
    const a = e.recordProviderContribution("prov2", rec, MS_PER_HOUR);
    expect(a.credits).toBe(1);
    const b = e.recordProviderContribution("prov2", rec, MS_PER_HOUR);
    expect(b.credits).toBe(0);
    expect(e.getLedger("prov2")).toHaveLength(1);
  });

  it("different periods => separate earnings", () => {
    const e = createEconomics({ now: () => 3000 });
    e.createAccount("prov3");
    const rec = makeRecord("sharing");
    const p1 = e.recordProviderContribution("prov3", rec, MS_PER_HOUR, "period-1");
    const p2 = e.recordProviderContribution("prov3", rec, MS_PER_HOUR, "period-2");
    expect(p1.credits).toBe(1);
    expect(p2.credits).toBe(1);
    expect(e.getBalance("prov3")).toBe(2);
    expect(e.getLedger("prov3")).toHaveLength(2);
    expect(e.getLedger("prov3")[0]!.id).toBe(1);
    expect(e.getLedger("prov3")[1]!.id).toBe(2);
    // Different duration also separate
    const p3 = e.recordProviderContribution("prov3", rec, 2 * MS_PER_HOUR, "period-1");
    expect(p3.credits).toBe(2);
    expect(e.getBalance("prov3")).toBe(4);
  });

  it("deterministic event identity — same inputs same key, different inputs different key", () => {
    const e1 = createEconomics({ now: () => 4000 });
    const e2 = createEconomics({ now: () => 4000 });
    e1.createAccount("prov4");
    e2.createAccount("prov4");
    const rec = makeRecord("sharing", BYTES_PER_GIB);
    // Both economics instances with same eventId should behave identically
    const r1 = e1.recordProviderContribution("prov4", rec, MS_PER_HOUR, "evtA");
    const r2 = e2.recordProviderContribution("prov4", rec, MS_PER_HOUR, "evtA");
    expect(r1.credits).toBe(r2.credits);
    expect(r1.entry?.amount).toBe(r2.entry?.amount);
    // Different providerId with same eventId is different event
    e1.createAccount("prov5");
    const diffProv = e1.recordProviderContribution("prov5", rec, MS_PER_HOUR, "evtA");
    expect(diffProv.credits).toBe(1);
  });

  it("ledger remains append-only, no silent mutation or deletion", () => {
    const e = createEconomics({ now: () => 5000 });
    e.createAccount("prov6");
    const rec = makeRecord("sharing");
    e.recordProviderContribution("prov6", rec, MS_PER_HOUR, "p1");
    const before = e.getLedger("prov6");
    expect(before).toHaveLength(1);
    const beforeCopy = JSON.stringify(before);
    // Duplicate should not mutate prior entry
    e.recordProviderContribution("prov6", rec, MS_PER_HOUR, "p1");
    const after = e.getLedger("prov6");
    expect(after).toHaveLength(1);
    expect(JSON.stringify(after)).toBe(beforeCopy);
    // New period appends
    e.recordProviderContribution("prov6", rec, MS_PER_HOUR, "p2");
    expect(e.getLedger("prov6")).toHaveLength(2);
    // Returned ledger copies are not live references
    const copy = e.getLedger("prov6");
    (copy as unknown as { length: number }).length = 0;
    expect(e.getLedger("prov6")).toHaveLength(2);
  });

  it("existing spending/issuance behavior unchanged — not idempotent via provider dedupe", () => {
    const e = createEconomics({ now: () => 6000 });
    e.createAccount("alice");
    e.issueCredits("alice", 10, "fund");
    expect(e.getBalance("alice")).toBe(10);
    // Spend is not deduped via provider event key
    e.spendCredits("alice", 3, "buy");
    expect(e.getBalance("alice")).toBe(7);
    e.spendCredits("alice", 3, "buy");
    expect(e.getBalance("alice")).toBe(4);
    expect(e.getLedger("alice").filter((l) => l.type === "spend")).toHaveLength(2);
  });
});
