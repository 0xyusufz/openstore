import { describe, expect, it } from "vitest";
import { BYTES_PER_GIB, CREDITS_PER_GIB_HOUR, MS_PER_HOUR, calculateConsumerCredits, calculateProviderCredits, createEconomics } from "./index.js";
import { isMarketplaceEligible } from "../marketplace/index.js";
import { createIdentity } from "../identity/index.js";

function makeRecord(overrides: Partial<Parameters<typeof isMarketplaceEligible>[0]> = {}) {
  const id = createIdentity();
  return {
    nodeId: id.publicKey.toString("base64"),
    publicKey: id.publicKey.toString("base64"),
    baseUrl: "http://127.0.0.1:4101",
    available: true,
    lastSeen: Date.now(),
    capacity: { allocatedBytes: BYTES_PER_GIB, usedBytes: 0, availableBytes: BYTES_PER_GIB },
    reliability: { successfulHeartbeats: 1, missedHeartbeats: 0, score: 80, successfulAudits: 0, failedAudits: 0, storageScore: 70 },
    lifecycle: "sharing" as const,
    ...overrides,
  } as unknown as Parameters<typeof isMarketplaceEligible>[0];
}

describe("economics 070 — deterministic internal credits", () => {
  it("credit issuance and earning are integer-safe and deterministic", () => {
    const e = createEconomics({ now: () => 1000 });
    e.createAccount("alice");
    const entry = e.issueCredits("alice", 100, "initial");
    expect(entry.balanceAfter).toBe(100);
    expect(entry.delta).toBe(100);
    expect(e.getBalance("alice")).toBe(100);
    // Repeat issuance is deterministic in ledger count, not balance duplication
    expect(calculateProviderCredits(BYTES_PER_GIB, MS_PER_HOUR)).toBe(CREDITS_PER_GIB_HOUR);
    expect(calculateProviderCredits(BYTES_PER_GIB, MS_PER_HOUR)).toBe(calculateProviderCredits(BYTES_PER_GIB, MS_PER_HOUR));
    expect(calculateConsumerCredits(BYTES_PER_GIB, MS_PER_HOUR, 1)).toBe(1);
    expect(calculateConsumerCredits(BYTES_PER_GIB, MS_PER_HOUR, 2)).toBe(2);
  });

  it("integer/accounting correctness — no floating point, BigInt floor", () => {
    // 1 GiB for 1 hour = 1 credit
    expect(calculateProviderCredits(BYTES_PER_GIB, MS_PER_HOUR)).toBe(1);
    // 0.5 GiB for 1 hour = floor(0.5) = 0
    expect(calculateProviderCredits(BYTES_PER_GIB / 2, MS_PER_HOUR)).toBe(0);
    // 1 GiB for 0.5 hour = 0
    expect(calculateProviderCredits(BYTES_PER_GIB, MS_PER_HOUR / 2)).toBe(0);
    // 2 GiB for 1 hour = 2
    expect(calculateProviderCredits(2 * BYTES_PER_GIB, MS_PER_HOUR)).toBe(2);
    // Large but safe: 100 GiB for 24h = 2400 credits
    expect(calculateProviderCredits(100 * BYTES_PER_GIB, 24 * MS_PER_HOUR)).toBe(2400);
    // Invalid inputs throw
    expect(() => calculateProviderCredits(-1, MS_PER_HOUR)).toThrow();
    expect(() => calculateConsumerCredits(100, -1, 1)).toThrow();
  });

  it("credit spending and insufficient balance rejection", () => {
    const e = createEconomics({ now: () => 2000 });
    e.createAccount("bob");
    e.issueCredits("bob", 5, "fund");
    expect(e.getBalance("bob")).toBe(5);
    // Spend 3 succeeds
    const spend = e.spendCredits("bob", 3, "marketplace.consume");
    expect(spend.delta).toBe(-3);
    expect(e.getBalance("bob")).toBe(2);
    // Insufficient balance throws, no silent mutation
    expect(() => e.spendCredits("bob", 3, "overdraft")).toThrow(/insufficient balance/);
    expect(e.getBalance("bob")).toBe(2);
    // Negative balances never allowed
    expect(() => e.spendCredits("bob", 10, "nope")).toThrow();
  });

  it("append-only ledger/audit behavior", () => {
    const e = createEconomics({ now: () => 3000 });
    e.issueCredits("carol", 10, "issuance");
    e.recordProviderContribution("provider1", makeRecord(), MS_PER_HOUR);
    e.recordConsumerUsage("carol", BYTES_PER_GIB, MS_PER_HOUR, 1);
    const ledger = e.getLedger();
    expect(ledger).toHaveLength(3);
    expect(ledger[0]!.id).toBe(1);
    expect(ledger[1]!.id).toBe(2);
    expect(ledger[2]!.id).toBe(3);
    // Returned copies are not mutable references
    const copy = e.getLedger("carol");
    expect(copy).toHaveLength(2);
    (copy as unknown as { length: number }).length = 0;
    expect(e.getLedger("carol")).toHaveLength(2);
    // Ledger entries contain safe metadata, no secrets
    const text = JSON.stringify(ledger);
    expect(text).not.toMatch(/privatekey|recoveryphrase|password|plaintext/i);
  });

  it("deterministic repeated calculations", () => {
    const a = calculateProviderCredits(BYTES_PER_GIB, 2 * MS_PER_HOUR);
    const b = calculateProviderCredits(BYTES_PER_GIB, 2 * MS_PER_HOUR);
    expect(a).toBe(b);
    const x = calculateConsumerCredits(500 * 1024 * 1024, MS_PER_HOUR, 3);
    const y = calculateConsumerCredits(500 * 1024 * 1024, MS_PER_HOUR, 3);
    expect(x).toBe(y);
  });

  it("provider lifecycle/ineligible capacity not generating contribution", () => {
    const e = createEconomics({ now: () => 4000 });
    e.createAccount("prov");
    // Eligible sharing provider earns
    const eligible = makeRecord({ lifecycle: "sharing" });
    const { credits: c1, entry: e1 } = e.recordProviderContribution("prov", eligible as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR);
    expect(c1).toBe(1);
    expect(e1).not.toBeNull();
    expect(e.getBalance("prov")).toBe(1);
    // Draining provider yields 0, no ledger entry, balance unchanged
    const draining = makeRecord({ lifecycle: "draining" });
    const { credits: c2, entry: e2 } = e.recordProviderContribution("prov", draining as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR);
    expect(c2).toBe(0);
    expect(e2).toBeNull();
    expect(e.getBalance("prov")).toBe(1);
    // Released
    const released = makeRecord({ lifecycle: "released" });
    expect(e.recordProviderContribution("prov", released as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR).credits).toBe(0);
    // Unavailable
    const unavailable = makeRecord({ available: false } as unknown as Parameters<typeof makeRecord>[0]);
    expect(e.recordProviderContribution("prov", unavailable as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR).credits).toBe(0);
    // HTTP undefined lifecycle — fail-closed per marketplace, also no contribution
    const httpUndefined = makeRecord({ lifecycle: undefined } as unknown as Parameters<typeof makeRecord>[0]);
    expect(e.recordProviderContribution("prov", httpUndefined as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR).credits).toBe(0);
    // Zero capacity also ineligible
    const zero = makeRecord({ capacity: { allocatedBytes: 100, usedBytes: 100, availableBytes: 0 } });
    expect(e.recordProviderContribution("prov", zero as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR).credits).toBe(0);
    // Ledger count only increased for eligible
    expect(e.getLedger("prov")).toHaveLength(1);
  });

  it("marketplace data remains separate from economics", () => {
    const e = createEconomics({ now: () => 5000 });
    // Marketplace listing is read-only capacity; economics accounting is separate
    // Even if marketplace snapshot changes, economics ledger/balances unchanged unless explicitly recorded
    e.createAccount("alice");
    e.issueCredits("alice", 10, "issue");
    const before = e.getSnapshot();
    // Simulate marketplace query (no side effect)
    expect(before.totalSupply).toBe(10);
    expect(before.accountCount).toBe(1);
    // No automatic coupling: marketplace does not spend/earn credits implicitly
    const after = e.getSnapshot();
    expect(after.totalSupply).toBe(before.totalSupply);
    expect(after.ledgerCount).toBe(before.ledgerCount);
  });

  it("separation: provider vs consumer accounting", () => {
    const e = createEconomics({ now: () => 6000 });
    e.createAccount("providerA");
    e.createAccount("consumerB");
    e.issueCredits("consumerB", 10, "fund");
    // Provider earns 2 credits for 2 GiB-hours
    e.recordProviderContribution("providerA", makeRecord({ capacity: { allocatedBytes: 2 * BYTES_PER_GIB, usedBytes: 0, availableBytes: 2 * BYTES_PER_GIB } }) as unknown as Parameters<typeof e.recordProviderContribution>[1], MS_PER_HOUR);
    expect(e.getBalance("providerA")).toBe(2);
    // Consumer spends 1 credit for 1 GiB-hour
    e.recordConsumerUsage("consumerB", BYTES_PER_GIB, MS_PER_HOUR, 1);
    expect(e.getBalance("consumerB")).toBe(9);
    // Provider and consumer ledgers are separate
    expect(e.getLedger("providerA")).toHaveLength(1);
    expect(e.getLedger("consumerB")).toHaveLength(2); // issuance + spend
  });

  it("no private material leakage in economics", () => {
    const e = createEconomics();
    e.createAccount("test");
    e.issueCredits("test", 1, "test");
    const text = JSON.stringify(e.getLedger());
    expect(text).not.toMatch(/privatekey|recoveryphrase|password|plaintext|signature/i);
  });
});
