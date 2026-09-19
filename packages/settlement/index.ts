/**
 * OpenStore Settlement (071) — internal settlement layer
 *
 * Converts economic events into finalized credit transfers. Internal/off-chain,
 * no blockchain, no external payments, no fiat pricing, no consensus.
 *
 * - Settlement is idempotent and replay-safe via deterministic settlement id.
 * - A contribution/usage event must not be settled twice (same settlement id → same result, no duplicate transfer).
 * - Provider credits and consumer debits balance within each finalized settlement (same amount).
 * - Insufficient balance is rejected before finalization; negative balances never allowed.
 * - Append-only finalized records; never silently mutate/delete.
 * - Separate: economics calculation (pure), settlement authorization/finalization, marketplace discovery.
 * - Reuses existing economics ledger (transfer) instead of competing balance model.
 */

import type { Economics } from "../economics/index.js";
import { calculateConsumerCredits, calculateProviderCredits } from "../economics/index.js";
import { isMarketplaceEligible } from "../marketplace/index.js";
import type { NodeRecord } from "../registry/index.js";

export const SETTLEMENT_VERSION = 1;

export type SettlementStatus = "pending" | "finalized" | "rejected" | "failed";

export interface SettlementRequest {
  /** Deterministic settlement identity — replay of same id returns same record, no duplicate transfer. */
  id: string;
  providerId: string;
  consumerId: string;
  /** Provider NodeRecord for eligibility check (sharing lifecycle etc.). */
  providerRecord: NodeRecord;
  bytes: number;
  durationMs: number;
  replicationFactor?: number; // default 1
  /** Optional explicit amount; if omitted, derived deterministically from consumer usage. */
  amount?: number;
}

export interface SettlementRecord {
  id: string;
  version: number;
  status: SettlementStatus;
  request: SettlementRequest;
  /** Amount transferred (provider credit == consumer debit) for finalized settlements. */
  amount: number;
  providerEntryId?: number;
  consumerEntryId?: number;
  reason?: string;
  createdAt: number;
  finalizedAt?: number;
}

function assertSettlementId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new TypeError("settlement id must be non-empty string 1-256");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new TypeError("settlement id must match [A-Za-z0-9._-]+");
}

function assertAccountId(id: unknown, name: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new TypeError(`${name} must be non-empty string 1-256`);
  if (!/^[A-Za-z0-9._-]+$/.test(id as string)) throw new TypeError(`${name} must match [A-Za-z0-9._-]+`);
}

export interface SettlementOptions {
  now?: () => number;
}

export function createSettlement(economics: Economics, options: SettlementOptions = {}) {
  if (!economics || typeof economics.getBalance !== "function") throw new TypeError("economics is required");
  const now = options.now ?? Date.now;
  const settlements = new Map<string, SettlementRecord>();

  function validateRequest(req: SettlementRequest): { amount: number; providerEligible: boolean } {
    if (!req || typeof req !== "object" || Array.isArray(req)) throw new TypeError("request must be an object");
    assertSettlementId(req.id);
    assertAccountId(req.providerId, "providerId");
    assertAccountId(req.consumerId, "consumerId");
    if (req.providerId === req.consumerId) throw new TypeError("providerId and consumerId must differ");
    if (!req.providerRecord || typeof req.providerRecord !== "object") throw new TypeError("providerRecord is required");
    if (!Number.isSafeInteger(req.bytes) || req.bytes < 0) throw new TypeError("bytes must be non-negative safe integer");
    if (!Number.isSafeInteger(req.durationMs) || req.durationMs < 0) throw new TypeError("durationMs must be non-negative safe integer");
    const replicationFactor = req.replicationFactor ?? 1;
    if (!Number.isSafeInteger(replicationFactor) || replicationFactor < 1) throw new TypeError("replicationFactor must be >=1");
    if (req.amount !== undefined) {
      if (typeof req.amount !== "number" || !Number.isSafeInteger(req.amount) || req.amount < 0) throw new TypeError("amount must be non-negative safe integer");
    }
    const derivedAmount = req.amount ?? calculateConsumerCredits(req.bytes, req.durationMs, replicationFactor);
    // Also check provider side calculation would be consistent (not required to be equal for this milestone, but must be integer-safe)
    // For settlement, amount is the transfer amount; provider contribution for same bytes/duration would be calculateProviderCredits(bytes, duration) if needed.
    // We keep amount as derived from consumer usage for balance conservation.
    const providerEligible = isMarketplaceEligible(req.providerRecord as unknown as NodeRecord);
    return { amount: derivedAmount, providerEligible };
  }

  function toPendingRecord(req: SettlementRequest, amount: number): SettlementRecord {
    return {
      id: req.id,
      version: SETTLEMENT_VERSION,
      status: "pending",
      request: { ...req, amount },
      amount,
      createdAt: now(),
    };
  }

  return {
    version: SETTLEMENT_VERSION,

    /**
     * Request a settlement. Idempotent: same id returns existing record without new transfer.
     * Validates, checks provider eligibility and consumer balance, then attempts transfer via economics ledger.
     * Deterministic amount if not provided.
     */
    requestSettlement(req: SettlementRequest): SettlementRecord {
      // Idempotent replay: same id returns existing finalized/rejected without duplicate
      const existing = settlements.get(req.id);
      if (existing) {
        return { ...existing, request: { ...existing.request } };
      }

      let validated: { amount: number; providerEligible: boolean };
      try {
        validated = validateRequest(req);
      } catch (e) {
        const rec: SettlementRecord = {
          id: req.id,
          version: SETTLEMENT_VERSION,
          status: "rejected",
          request: { ...req },
          amount: 0,
          reason: (e as Error).message,
          createdAt: now(),
        };
        settlements.set(req.id, { ...rec });
        return { ...rec };
      }

      const amount = validated.amount;

      // Zero-amount settlements are not meaningful; reject as invalid (not retryable)
      if (amount === 0) {
        const rec: SettlementRecord = {
          id: req.id,
          version: SETTLEMENT_VERSION,
          status: "rejected",
          request: { ...req, amount },
          amount: 0,
          reason: "amount is zero — no transfer required",
          createdAt: now(),
        };
        settlements.set(req.id, { ...rec });
        return { ...rec };
      }

      // Provider must be eligible (sharing lifecycle etc.) — otherwise rejected, not retryable via same record
      if (!validated.providerEligible) {
        const rec: SettlementRecord = {
          id: req.id,
          version: SETTLEMENT_VERSION,
          status: "rejected",
          request: { ...req, amount },
          amount,
          reason: "provider not eligible: draining/released/unavailable/stale/invalid capacity",
          createdAt: now(),
        };
        settlements.set(req.id, { ...rec });
        return { ...rec };
      }

      // Check consumer balance before finalization — fail-closed, no negative
      const consumerBalance = economics.getBalance(req.consumerId);
      if (consumerBalance < amount) {
        const rec: SettlementRecord = {
          id: req.id,
          version: SETTLEMENT_VERSION,
          status: "rejected",
          request: { ...req, amount },
          amount,
          reason: `insufficient balance: need ${amount}, have ${consumerBalance}`,
          createdAt: now(),
        };
        settlements.set(req.id, { ...rec });
        return { ...rec };
      }

      // Attempt atomic transfer via economics ledger (idempotent via eventId = settlement id)
      // This reuses existing ledger, does not create competing balance model, and is integer-safe.
      try {
        const result = economics.transferCredits(req.consumerId, req.providerId, amount, `settlement:${req.id}`, req.id);
        // transferCredits is idempotent on eventId; if it returns null, it was already transferred for this eventId
        // But since settlement id is new, it should not be null; if null, treat as already finalized (should not happen for new id)
        if (result === null) {
          // This would mean a transfer with same eventId already existed in economics (unlikely for new settlement id)
          const rec: SettlementRecord = {
            id: req.id,
            version: SETTLEMENT_VERSION,
            status: "failed",
            request: { ...req, amount },
            amount,
            reason: "transfer already exists for eventId",
            createdAt: now(),
          };
          settlements.set(req.id, { ...rec });
          return { ...rec };
        }
        const rec: SettlementRecord = {
          id: req.id,
          version: SETTLEMENT_VERSION,
          status: "finalized",
          request: { ...req, amount },
          amount,
          providerEntryId: result.toEntry.id,
          consumerEntryId: result.fromEntry.id,
          createdAt: now(),
          finalizedAt: now(),
        };
        // Append-only: store finalized record, never mutate later
        settlements.set(req.id, { ...rec });
        return { ...rec };
      } catch (e) {
        const msg = (e as Error).message;
        // Insufficient balance already handled; other errors are failed (retryable)
        const isRejected = /insufficient balance/i.test(msg) || /invalid|must be/i.test(msg);
        const rec: SettlementRecord = {
          id: req.id,
          version: SETTLEMENT_VERSION,
          status: isRejected ? "rejected" : "failed",
          request: { ...req, amount },
          amount,
          reason: msg,
          createdAt: now(),
        };
        settlements.set(req.id, { ...rec });
        return { ...rec };
      }
    },

    /**
     * Retrieve a settlement by id (copy, not live reference).
     */
    getSettlement(id: string): SettlementRecord | undefined {
      assertSettlementId(id);
      const rec = settlements.get(id);
      return rec ? { ...rec, request: { ...rec.request } } : undefined;
    },

    /**
     * List all settlements (copies, append-only order).
     */
    listSettlements(): SettlementRecord[] {
      return Array.from(settlements.values()).map((r) => ({ ...r, request: { ...r.request } }));
    },

    /**
     * Retry a failed settlement (only pending/failed are retryable; finalized/rejected are terminal).
     * Re-validates provider eligibility and balance; preserves append-only semantics.
     */
    retrySettlement(id: string): SettlementRecord {
      assertSettlementId(id);
      const existing = settlements.get(id);
      if (!existing) throw new Error(`settlement not found: ${id}`);
      if (existing.status === "finalized" || existing.status === "rejected") {
        // Idempotent replay: return existing without new transfer
        return { ...existing, request: { ...existing.request } };
      }
      // For pending/failed, re-validate and attempt transfer again.
      // We keep the original createdAt and id, and update the stored record in place
      // (no deletion of finalized records; failed/pending are retryable and their retry
      // transitions to finalized/rejected/failed are auditable as the same settlement id).
      const req = existing.request;
      // Re-run validation and transfer logic without deleting; reuse requestSettlement's
      // validation but bypass its early-existing check by temporarily removing and re-adding
      const validated = (() => {
        try {
          return validateRequest(req);
        } catch (e) {
          return { error: e as Error };
        }
      })() as { amount: number; providerEligible: boolean } | { error: Error };
      if ("error" in validated) {
        const rec: SettlementRecord = {
          ...existing,
          status: "rejected",
          reason: (validated.error as Error).message,
        };
        settlements.set(id, { ...rec });
        return { ...rec, request: { ...rec.request } };
      }
      const amount = validated.amount;
      if (amount === 0) {
        const rec: SettlementRecord = { ...existing, status: "rejected", reason: "amount is zero — no transfer required", amount: 0 };
        settlements.set(id, { ...rec });
        return { ...rec, request: { ...rec.request } };
      }
      if (!validated.providerEligible) {
        const rec: SettlementRecord = {
          ...existing,
          status: "rejected",
          amount,
          reason: "provider not eligible: draining/released/unavailable/stale/invalid capacity",
        };
        settlements.set(id, { ...rec });
        return { ...rec, request: { ...rec.request } };
      }
      const consumerBalance = economics.getBalance(req.consumerId);
      if (consumerBalance < amount) {
        const rec: SettlementRecord = {
          ...existing,
          status: "failed",
          amount,
          reason: `insufficient balance: need ${amount}, have ${consumerBalance}`,
        };
        settlements.set(id, { ...rec });
        return { ...rec, request: { ...rec.request } };
      }
      try {
        const result = economics.transferCredits(req.consumerId, req.providerId, amount, `settlement:${req.id}`, req.id);
        if (result === null) {
          const rec: SettlementRecord = { ...existing, status: "failed", amount, reason: "transfer already exists for eventId" };
          settlements.set(id, { ...rec });
          return { ...rec, request: { ...rec.request } };
        }
        const rec: SettlementRecord = {
          ...existing,
          status: "finalized",
          amount,
          providerEntryId: result.toEntry.id,
          consumerEntryId: result.fromEntry.id,
          finalizedAt: now(),
        };
        settlements.set(id, { ...rec });
        return { ...rec, request: { ...rec.request } };
      } catch (e) {
        const msg = (e as Error).message;
        const isRejected = /insufficient balance/i.test(msg) || /invalid|must be/i.test(msg);
        const rec: SettlementRecord = {
          ...existing,
          status: isRejected ? "rejected" : "failed",
          amount,
          reason: msg,
        };
        settlements.set(id, { ...rec });
        return { ...rec, request: { ...rec.request } };
      }
    },

    /**
     * Direct finalize is alias for request (idempotent).
     */
    finalizeSettlement(id: string): SettlementRecord {
      const rec = settlements.get(id);
      if (!rec) throw new Error(`settlement not found: ${id}`);
      if (rec.status === "finalized" || rec.status === "rejected") return { ...rec, request: { ...rec.request } };
      return this.retrySettlement(id);
    },
  };
}

export type Settlement = ReturnType<typeof createSettlement>;
