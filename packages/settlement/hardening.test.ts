import { describe, expect, it } from "vitest";
import { BYTES_PER_GIB, MS_PER_HOUR, createEconomics } from "../economics/index.js";
import { createIdentity } from "../identity/index.js";
import { createSettlement } from "./index.js";

function makeRecord(lifecycle: "sharing" | "draining" | "released" | undefined, allocatedBytes = BYTES_PER_GIB) {
  const id = createIdentity();
  return {
    nodeId: id.publicKey.toString("base64"),
    publicKey: id.publicKey.toString("base64"),
    baseUrl: "http://127.0.0.1:4101",
    available: true,
    lastSeen: Date.now(),
    capacity: { allocatedBytes, usedBytes: 0, availableBytes: allocatedBytes },
    reliability: { successfulHeartbeats: 1, missedHeartbeats: 0, score: 80, successfulAudits: 0, failedAudits: 0, storageScore: 70 },
    lifecycle: lifecycle as unknown as string,
  } as unknown as import("../registry/index.js").NodeRecord;
}

describe("settlement 071 hardening — atomicity & transfer boundary", () => {
  it("failure atomicity — insufficient balance leaves no partial ledger/balance mutation and retry is safe", () => {
    const economics = createEconomics({ now: () => 1000 });
    economics.issueCredits("consumer", 1, "fund");
    const beforeBalanceProv = economics.getBalance("provider");
    const beforeBalanceCons = economics.getBalance("consumer");
    const beforeLedger = economics.getLedger().length;
    const settlement = createSettlement(economics, { now: () => 1001 });
    const rec = makeRecord("sharing", BYTES_PER_GIB);
    // Need 2 credits but consumer has 1
    const req = { id: "atomic-1", providerId: "provider", consumerId: "consumer", providerRecord: rec, bytes: 2 * BYTES_PER_GIB, durationMs: MS_PER_HOUR };
    const result = settlement.requestSettlement(req as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(result.status).toBe("rejected");
    expect(economics.getBalance("provider")).toBe(beforeBalanceProv);
    expect(economics.getBalance("consumer")).toBe(beforeBalanceCons);
    expect(economics.getLedger()).toHaveLength(beforeLedger + 0); // no new entries for rejected
    // Retry after funding should succeed and be atomic
    economics.issueCredits("consumer", 2, "fund2");
    const retry = settlement.retrySettlement("atomic-1");
    // Note: rejected is terminal, so retry should return same rejected without new transfer
    expect(retry.status).toBe("rejected");
    expect(economics.getLedger()).toHaveLength(beforeLedger + 1); // only the second issuance, no settlement entries yet for first
    // New settlement with sufficient balance should finalize atomically
    const good = settlement.requestSettlement({ id: "atomic-2", providerId: "provider", consumerId: "consumer", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(good.status).toBe("finalized");
    expect(economics.getBalance("consumer")).toBe(2); // started 1, +2 issuance =3, -1 for good =2
    expect(economics.getBalance("provider")).toBe(1);
    // Ledger has 2 entries for the successful settlement (spend + earn) plus 2 issuances
    expect(economics.getLedger()).toHaveLength(beforeLedger + 3); // 2 issuances + 2 settlement entries
  });

  it("partial-transfer protection — transfer failure does not leave half-ledger", () => {
    const economics = createEconomics({ now: () => 2000 });
    economics.issueCredits("consumer", 10, "fund");
    // Force provider balance near MAX_SAFE_INTEGER to cause overflow on credit
    economics.createAccount("provider");
    // Issue up to MAX -1
    economics.issueCredits("provider", Number.MAX_SAFE_INTEGER - 1, "fund-provider");
    const settlement = createSettlement(economics, { now: () => 2001 });
    const rec = makeRecord("sharing");
    const beforeLedger = economics.getLedger().length;
    const beforeProvBal = economics.getBalance("provider");
    const beforeConsBal = economics.getBalance("consumer");
    // Try to transfer 2 credits (2 GiB for 1 hour) which would exceed MAX for provider
    const res = settlement.requestSettlement({ id: "partial-1", providerId: "provider", consumerId: "consumer", providerRecord: rec, bytes: 2 * BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/exceed safe integer/);
    // No partial mutation: balances unchanged, no new ledger entries
    expect(economics.getBalance("provider")).toBe(beforeProvBal);
    expect(economics.getBalance("consumer")).toBe(beforeConsBal);
    expect(economics.getLedger()).toHaveLength(beforeLedger);
    // Retry with non-overflowing provider should be safe
    const rec2 = makeRecord("sharing");
    const res2 = settlement.requestSettlement({ id: "partial-2", providerId: "provider2", consumerId: "consumer", providerRecord: rec2, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(res2.status).toBe("finalized");
  });

  it("transfer boundary — direct economics.transferCredits bypass is rejected", () => {
    const economics = createEconomics();
    economics.issueCredits("alice", 10, "fund");
    economics.createAccount("bob");
    // Direct transfer with non-settlement reason should be rejected
    expect(() => (economics as unknown as { transferCredits: (a: string, b: string, c: number, d: string) => unknown }).transferCredits("alice", "bob", 1, "transfer")).toThrow(/internal to settlement/);
    expect(() => (economics as unknown as { transferCredits: (a: string, b: string, c: number, d: string, e: string) => unknown }).transferCredits("alice", "bob", 1, "spend", "some-id")).toThrow(/internal to settlement/);
    // Correct settlement path still works
    economics.issueCredits("consumer", 5, "fund2");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const ok = settlement.requestSettlement({ id: "boundary-1", providerId: "bob", consumerId: "consumer", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(ok.status).toBe("finalized");
    expect(economics.getBalance("bob")).toBe(1);
  });

  it("replay preserves exact accounting state — finalized vs failed distinguishable", () => {
    const economics = createEconomics({ now: () => 3000 });
    economics.issueCredits("cons", 5, "fund");
    const settlement = createSettlement(economics, { now: () => 3001 });
    const rec = makeRecord("sharing");
    const first = settlement.requestSettlement({ id: "replay-1", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(first.status).toBe("finalized");
    const balAfterFirstProv = economics.getBalance("prov");
    const balAfterFirstCons = economics.getBalance("cons");
    const ledgerAfterFirst = economics.getLedger().length;
    // Replay same id
    const replay = settlement.requestSettlement({ id: "replay-1", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(replay.status).toBe("finalized");
    expect(replay.providerEntryId).toBe(first.providerEntryId);
    expect(economics.getBalance("prov")).toBe(balAfterFirstProv);
    expect(economics.getBalance("cons")).toBe(balAfterFirstCons);
    expect(economics.getLedger()).toHaveLength(ledgerAfterFirst);
    // Failed replay remains failed, not silently promoted
    const failRec = makeRecord("draining");
    const fail = settlement.requestSettlement({ id: "replay-fail", providerId: "prov", consumerId: "cons", providerRecord: failRec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(fail.status).toBe("rejected");
    const failReplay = settlement.requestSettlement({ id: "replay-fail", providerId: "prov", consumerId: "cons", providerRecord: failRec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(failReplay.status).toBe("rejected");
    expect(failReplay.reason).toBe(fail.reason);
  });

  it("conservation — every finalized settlement has consumer delta == -amount and provider delta == +amount, totalSupply unchanged", () => {
    const economics = createEconomics({ now: () => 4000 });
    economics.issueCredits("c1", 10, "fund");
    const beforeSupply = economics.getTotalSupply();
    const settlement = createSettlement(economics, { now: () => 4001 });
    const rec = makeRecord("sharing", 2 * BYTES_PER_GIB);
    const res = settlement.requestSettlement({ id: "cons-1", providerId: "p1", consumerId: "c1", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(res.status).toBe("finalized");
    const ledger = economics.getLedger();
    const providerEntry = ledger.find((e) => e.id === res.providerEntryId)!;
    const consumerEntry = ledger.find((e) => e.id === res.consumerEntryId)!;
    expect(providerEntry.delta).toBe(res.amount);
    expect(consumerEntry.delta).toBe(-res.amount);
    expect(providerEntry.amount).toBe(consumerEntry.amount);
    expect(economics.getTotalSupply()).toBe(beforeSupply); // transfer does not change totalSupply
  });
});
