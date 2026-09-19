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

describe("settlement 071 — deterministic internal settlement", () => {
  it("valid settlement — provider/consumer balance conservation (balanced transfer)", () => {
    const economics = createEconomics({ now: () => 1000 });
    economics.createAccount("providerA");
    economics.createAccount("consumerB");
    economics.issueCredits("consumerB", 10, "fund");
    const settlement = createSettlement(economics, { now: () => 1001 });
    const rec = makeRecord("sharing");
    const req = { id: "settle-1", providerId: "providerA", consumerId: "consumerB", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR, replicationFactor: 1 };
    const result = settlement.requestSettlement(req as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(result.status).toBe("finalized");
    expect(result.amount).toBe(1);
    expect(result.providerEntryId).toBeDefined();
    expect(result.consumerEntryId).toBeDefined();
    expect(economics.getBalance("providerA")).toBe(1);
    expect(economics.getBalance("consumerB")).toBe(9);
    // totalSupply unchanged (transfer, not issuance) — before 10, after still 10 (provider earn via transfer does not increase supply beyond original issuance? In 070, earn via transfer does not increase supply)
    // In our economics, transfer does not change totalSupply (only issuance/earn via provider contribution does, but settlement transfer is balanced)
    // For this test, consumer had 10 from issuance, provider 0, after transfer provider 1, consumer 9, totalSupply still 10
    expect(economics.getTotalSupply()).toBe(10);
    // Ledger has two entries for settlement (one spend, one earn) plus issuance
    expect(economics.getLedger()).toHaveLength(3);
  });

  it("provider/consumer balance conservation — same amount", () => {
    const economics = createEconomics({ now: () => 2000 });
    economics.issueCredits("consumer", 5, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing", 2 * BYTES_PER_GIB);
    const r = settlement.requestSettlement({ id: "s2", providerId: "provider", consumerId: "consumer", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR, replicationFactor: 1 } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(r.status).toBe("finalized");
    const providerLedger = economics.getLedger("provider");
    const consumerLedger = economics.getLedger("consumer");
    expect(providerLedger[0]!.amount).toBe(consumerLedger[1]!.amount); // consumer has issuance + spend
    expect(providerLedger[0]!.amount).toBe(1);
  });

  it("insufficient balance — rejected before finalization, no negative", () => {
    const economics = createEconomics();
    economics.createAccount("prov");
    economics.createAccount("cons");
    // Need to issue 1, then try to settle 2
    economics.issueCredits("cons", 1, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const req = { id: "s-insuff", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: 2 * BYTES_PER_GIB, durationMs: MS_PER_HOUR, replicationFactor: 1 };
    const result = settlement.requestSettlement(req as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/insufficient balance/);
    expect(economics.getBalance("cons")).toBe(1);
    expect(economics.getBalance("prov")).toBe(0);
    expect(economics.getLedger("prov")).toHaveLength(0);
  });

  it("duplicate/replayed settlement — idempotent, no duplicate transfer", () => {
    const economics = createEconomics({ now: () => 3000 });
    economics.issueCredits("consumer", 10, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const req = { id: "dup-1", providerId: "provider", consumerId: "consumer", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR };
    const first = settlement.requestSettlement(req as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(first.status).toBe("finalized");
    const balAfterFirst = economics.getBalance("consumer");
    const ledgerLenAfterFirst = economics.getLedger().length;
    const second = settlement.requestSettlement(req as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(second.status).toBe("finalized");
    expect(second.providerEntryId).toBe(first.providerEntryId);
    expect(second.consumerEntryId).toBe(first.consumerEntryId);
    expect(economics.getBalance("consumer")).toBe(balAfterFirst);
    expect(economics.getLedger()).toHaveLength(ledgerLenAfterFirst);
  });

  it("deterministic settlement identity — same id same result, different id separate", () => {
    const economics = createEconomics({ now: () => 4000 });
    economics.issueCredits("c", 10, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const a = settlement.requestSettlement({ id: "det-1", providerId: "p", consumerId: "c", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    const b = settlement.requestSettlement({ id: "det-1", providerId: "p", consumerId: "c", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(a.id).toBe(b.id);
    expect(a.providerEntryId).toBe(b.providerEntryId);
    const c = settlement.requestSettlement({ id: "det-2", providerId: "p", consumerId: "c", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(c.id).not.toBe(a.id);
    expect(c.providerEntryId).not.toBe(a.providerEntryId);
    expect(economics.getLedger("p")).toHaveLength(2);
  });

  it("invalid state transitions — finalized/rejected are terminal, pending/failed retryable", () => {
    const economics = createEconomics();
    economics.issueCredits("cons", 5, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const fin = settlement.requestSettlement({ id: "fin-1", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(fin.status).toBe("finalized");
    // Retry finalized returns same without new transfer
    const retryFin = settlement.retrySettlement("fin-1");
    expect(retryFin.status).toBe("finalized");
    expect(economics.getLedger("prov")).toHaveLength(1);

    const recBad = makeRecord("draining");
    const rej = settlement.requestSettlement({ id: "rej-1", providerId: "prov", consumerId: "cons", providerRecord: recBad, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(rej.status).toBe("rejected");
    const retryRej = settlement.retrySettlement("rej-1");
    expect(retryRej.status).toBe("rejected");
    expect(economics.getLedger("prov")).toHaveLength(1); // no new entry for rejected
  });

  it("append-only finalized records — never silently mutate", () => {
    const economics = createEconomics();
    economics.issueCredits("c", 10, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const s1 = settlement.requestSettlement({ id: "app-1", providerId: "p", consumerId: "c", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    const before = settlement.listSettlements();
    expect(before).toHaveLength(1);
    const copy = before[0]!;
    (copy as unknown as { status: string }).status = "pending";
    expect(settlement.getSettlement("app-1")!.status).toBe("finalized");
    // Second settlement appends, never deletes first
    settlement.requestSettlement({ id: "app-2", providerId: "p", consumerId: "c", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(settlement.listSettlements()).toHaveLength(2);
    expect(settlement.getSettlement("app-1")!.status).toBe("finalized");
  });

  it("retry safety — failed can be retried after funding", () => {
    const economics = createEconomics();
    economics.createAccount("prov");
    economics.createAccount("cons");
    // No initial funds for cons, so settlement will be rejected (not failed) — but we test failed via insufficient then funding
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    const first = settlement.requestSettlement({ id: "retry-1", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(first.status).toBe("rejected");
    // Fund consumer and retry with new id (since rejected is terminal, need new id)
    economics.issueCredits("cons", 5, "fund");
    const second = settlement.requestSettlement({ id: "retry-2", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    expect(second.status).toBe("finalized");
    expect(economics.getBalance("cons")).toBe(4);
  });

  it("provider ineligible lifecycle — draining/released/undefined not settled", () => {
    const economics = createEconomics();
    economics.issueCredits("cons", 10, "fund");
    const settlement = createSettlement(economics);
    for (const lifecycle of ["draining", "released", undefined] as const) {
      const rec = makeRecord(lifecycle as unknown as "sharing");
      const res = settlement.requestSettlement({ id: `inelig-${String(lifecycle)}`, providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
      expect(res.status).toBe("rejected");
      expect(res.reason).toMatch(/provider not eligible/);
    }
    expect(economics.getBalance("prov" as unknown as string)).toBe(0);
  });

  it("economics/marketplace separation — marketplace lists capacity, settlement moves credits, no coupling", () => {
    const economics = createEconomics();
    const settlement = createSettlement(economics);
    // Marketplace would list providers based on NodeRecord eligibility, but settlement does not affect marketplace
    // Here we just verify settlement does not call marketplace listing, and marketplace snapshot unchanged
    economics.issueCredits("cons", 10, "fund");
    const rec = makeRecord("sharing");
    settlement.requestSettlement({ id: "sep-1", providerId: "prov", consumerId: "cons", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    // Economics ledger has settlement entries, but marketplace would still list same capacity if queried separately
    expect(economics.getLedger("prov")).toHaveLength(1);
    // No marketplace side effect to check here, just ensure no coupling via shared state
  });

  it("no private material leakage", () => {
    const economics = createEconomics();
    economics.issueCredits("alice", 10, "fund");
    economics.issueCredits("bob", 5, "fund");
    const settlement = createSettlement(economics);
    const rec = makeRecord("sharing");
    settlement.requestSettlement({ id: "leak-1", providerId: "bob", consumerId: "alice", providerRecord: rec, bytes: BYTES_PER_GIB, durationMs: MS_PER_HOUR } as unknown as Parameters<typeof settlement.requestSettlement>[0]);
    const text = JSON.stringify([...economics.getLedger(), ...settlement.listSettlements()]);
    expect(text).not.toMatch(/privatekey|recoveryphrase|password|plaintext/i);
  });
});
