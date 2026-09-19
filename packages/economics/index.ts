/**
 * OpenStore Economics (070) — deterministic internal credits/accounting
 *
 * Internal credits model for future marketplace usage. No real money,
 * fiat prices, blockchain, or settlement finality. All accounting is
 * integer-safe, deterministic, and auditable.
 *
 * Units:
 * - 1 credit = 1_000_000 micro-credits (not exposed, internal base is credits as integer)
 * - For this milestone the base unit is 1 credit (integer). Conversions use
 *   integer arithmetic with floor division; no floating point.
 * - Provider contribution: credits = bytes * duration * rate / (BYTES_PER_GIB * MS_PER_HOUR)
 * - Consumer usage: same but multiplied by replicationFactor
 *
 * Separation:
 * - provider contribution accounting (earn)
 * - consumer usage accounting (spend)
 * - marketplace capacity discovery (read-only, separate)
 *
 * Ledger is append-only; balances never negative (except via explicitly documented future overdraft, not used here).
 */

import type { NodeRecord } from "../registry/index.js";
import { isMarketplaceEligible } from "../marketplace/index.js";

export const ECONOMICS_VERSION = 1;

// Explicit units — avoid floating point money math.
export const BYTES_PER_GIB = 1024 * 1024 * 1024;
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
// Minimal internal rate: 1 credit per GiB-hour. Integer-safe, deterministic.
// Future milestones may adjust rate but must keep explicit numerator/denominator.
export const CREDITS_PER_GIB_HOUR = 1;

export type AccountId = string;
export type CreditAmount = number; // non-negative safe integer

export type LedgerEntryType = "issuance" | "earn" | "spend" | "adjustment";

export interface LedgerEntry {
  id: number; // monotonic
  timestamp: number;
  accountId: AccountId;
  type: LedgerEntryType;
  amount: CreditAmount; // positive for issuance/earn, positive for spend (deduction), but stored as positive with balanceAfter
  delta: number; // +amount for earn/issuance, -amount for spend
  balanceAfter: CreditAmount;
  reason: string;
  // Safe operational metadata only — no secrets
  metadata?: {
    bytes?: number;
    durationMs?: number;
    replicationFactor?: number;
    providerId?: string;
  };
}

export interface Account {
  id: AccountId;
  balance: CreditAmount;
  createdAt: number;
}

export interface EconomicsSnapshot {
  version: number;
  totalSupply: CreditAmount;
  accountCount: number;
  ledgerCount: number;
  generatedAt: number;
}

function assertAccountId(id: unknown): asserts id is AccountId {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new TypeError("accountId must be non-empty string 1-256");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new TypeError("accountId must match [A-Za-z0-9._-]+");
}

function assertCreditAmount(amount: unknown, name = "amount"): asserts amount is CreditAmount {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new TypeError(`${name} must be non-negative safe integer`);
  if (amount > Number.MAX_SAFE_INTEGER) throw new RangeError(`${name} exceeds safe integer`);
}

function creditsForBytesDuration(bytes: number, durationMs: number, replicationFactor = 1): CreditAmount {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("bytes must be non-negative safe integer");
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new TypeError("durationMs must be non-negative safe integer");
  if (!Number.isSafeInteger(replicationFactor) || replicationFactor < 1) throw new TypeError("replicationFactor must be >=1 safe integer");
  if (bytes === 0 || durationMs === 0) return 0;
  // Integer-safe: (bytes * durationMs * CREDITS_PER_GIB_HOUR * replicationFactor) / (BYTES_PER_GIB * MS_PER_HOUR)
  // Use BigInt to avoid intermediate overflow beyond MAX_SAFE_INTEGER, then floor.
  const numerator = BigInt(bytes) * BigInt(durationMs) * BigInt(CREDITS_PER_GIB_HOUR) * BigInt(replicationFactor);
  const denominator = BigInt(BYTES_PER_GIB) * BigInt(MS_PER_HOUR);
  const credits = numerator / denominator; // floor
  if (credits > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("credits exceed safe integer");
  return Number(credits);
}

export function calculateProviderCredits(allocationBytes: number, durationMs: number): CreditAmount {
  return creditsForBytesDuration(allocationBytes, durationMs, 1);
}

export function calculateConsumerCredits(bytesStored: number, durationMs: number, replicationFactor = 1): CreditAmount {
  return creditsForBytesDuration(bytesStored, durationMs, replicationFactor);
}

export interface EconomicsOptions {
  // Allow injecting time for deterministic tests
  now?: () => number;
}

export function createEconomics(options: EconomicsOptions = {}) {
  const now = options.now ?? Date.now;
  const accounts = new Map<AccountId, Account>();
  const ledger: LedgerEntry[] = [];
  let nextId = 1;
  let totalSupply = 0;
  // Deterministic idempotency for provider contribution periods.
  // Repeating the exact same accounting event (same provider, same NodeRecord identity/capacity, same duration, same eventId)
  // must not issue credits twice. Different periods (different eventId or different capacity/duration) remain separate earnings.
  // Ledger remains append-only; duplicates produce no new entry and no balance change.
  const seenProviderEvents = new Set<string>();
  // Idempotency for explicit transfers (used by settlement). Same eventId => same transfer not repeated.
  const seenTransfers = new Set<string>();

  function getAccount(id: AccountId): Account | undefined {
    const acc = accounts.get(id);
    return acc ? { ...acc } : undefined;
  }

  function ensureAccount(id: AccountId): Account {
    assertAccountId(id);
    let acc = accounts.get(id);
    if (!acc) {
      acc = { id, balance: 0, createdAt: now() };
      accounts.set(id, acc);
    }
    return acc;
  }

  function appendEntry(entry: Omit<LedgerEntry, "id" | "timestamp"> & { timestamp?: number }): LedgerEntry {
    const e: LedgerEntry = {
      id: nextId++,
      timestamp: entry.timestamp ?? now(),
      accountId: entry.accountId,
      type: entry.type,
      amount: entry.amount,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
    };
    ledger.push(e);
    return { ...e, metadata: e.metadata ? { ...e.metadata } : undefined };
  }

  return {
    version: ECONOMICS_VERSION,
    // Deterministic pure calculation helpers (no state)
    calculateProviderCredits,
    calculateConsumerCredits,

    createAccount(id: AccountId): Account {
      assertAccountId(id);
      if (accounts.has(id)) throw new Error(`account already exists: ${id}`);
      const acc: Account = { id, balance: 0, createdAt: now() };
      accounts.set(id, { ...acc });
      return { ...acc };
    },

    getAccount,

    getBalance(id: AccountId): CreditAmount {
      assertAccountId(id);
      const acc = accounts.get(id);
      return acc ? acc.balance : 0;
    },

    getLedger(accountId?: AccountId): LedgerEntry[] {
      if (accountId !== undefined) assertAccountId(accountId);
      const filtered = accountId ? ledger.filter((e) => e.accountId === accountId) : ledger;
      return filtered.map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : undefined }));
    },

    getSnapshot(): EconomicsSnapshot {
      return {
        version: ECONOMICS_VERSION,
        totalSupply,
        accountCount: accounts.size,
        ledgerCount: ledger.length,
        generatedAt: now(),
      };
    },

    getTotalSupply(): CreditAmount {
      return totalSupply;
    },

    /**
     * Issue credits to an account (e.g., initial allocation). Append-only ledger.
     */
    issueCredits(accountId: AccountId, amount: CreditAmount, reason = "issuance"): LedgerEntry {
      assertAccountId(accountId);
      assertCreditAmount(amount, "amount");
      if (amount === 0) throw new TypeError("amount must be >0 for issuance");
      const acc = ensureAccount(accountId);
      if (acc.balance > Number.MAX_SAFE_INTEGER - amount) throw new RangeError("balance would exceed safe integer");
      acc.balance += amount;
      totalSupply += amount;
      accounts.set(accountId, { ...acc });
      return appendEntry({
        accountId,
        type: "issuance",
        amount,
        delta: amount,
        balanceAfter: acc.balance,
        reason,
      });
    },

    /**
     * Record provider contribution. Only eligible providers (sharing lifecycle, available, etc.)
     * generate credits, reusing marketplace eligibility. Ineligible capacity yields 0 and no ledger entry.
     * Idempotent: repeating the exact same event (same providerId, same NodeRecord identity/capacity, same durationMs, same eventId)
     * produces no duplicate credits and no new ledger entry. Different eventId / capacity / duration are separate earnings.
     * Ledger remains append-only; prior entries are never mutated or deleted.
     */
    recordProviderContribution(
      providerId: AccountId,
      record: NodeRecord | { capacity: { allocatedBytes?: number; totalBytes?: number; usedBytes: number; availableBytes: number }; lifecycle?: string; available?: boolean; reliability?: unknown; baseUrl?: string; nodeId?: string; lastSeen?: number },
      durationMs: number,
      eventId?: string,
    ): { credits: CreditAmount; entry: LedgerEntry | null } {
      assertAccountId(providerId);
      if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new TypeError("durationMs must be non-negative safe integer");
      if (eventId !== undefined && (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 256)) throw new TypeError("eventId must be non-empty string 1-256 if provided");
      // Reuse marketplace eligibility — excludes draining/released/unavailable/stale/invalid capacity, and HTTP undefined fail-closed
      const eligible = isMarketplaceEligible(record as unknown as NodeRecord);
      if (!eligible) return { credits: 0, entry: null };
      const allocated = (record.capacity as { allocatedBytes?: number; totalBytes?: number }).allocatedBytes ?? (record.capacity as { totalBytes?: number }).totalBytes ?? 0;
      if (allocated === undefined || !Number.isSafeInteger(allocated) || allocated <= 0) return { credits: 0, entry: null };
      const credits = calculateProviderCredits(allocated, durationMs);
      if (credits === 0) return { credits: 0, entry: null };
      // Deterministic event identity: explicit eventId if provided, else derived from providerId + nodeId + allocated + duration
      // This makes identical submissions idempotent while genuinely different periods (different eventId/capacity/duration) remain separate.
      const nodeIdPart = (record as { nodeId?: string }).nodeId ?? "";
      const derivedKey = `${providerId}|${nodeIdPart}|${allocated}|${durationMs}`;
      const eventKey = eventId !== undefined ? `id:${eventId}|${derivedKey}` : `auto:${derivedKey}`;
      if (seenProviderEvents.has(eventKey)) {
        return { credits: 0, entry: null };
      }
      seenProviderEvents.add(eventKey);
      const acc = ensureAccount(providerId);
      if (acc.balance > Number.MAX_SAFE_INTEGER - credits) throw new RangeError("balance would exceed safe integer");
      acc.balance += credits;
      totalSupply += credits;
      accounts.set(providerId, { ...acc });
      const entry = appendEntry({
        accountId: providerId,
        type: "earn",
        amount: credits,
        delta: credits,
        balanceAfter: acc.balance,
        reason: "provider.contribution",
        metadata: { bytes: allocated, durationMs, providerId: (record as NodeRecord).nodeId ?? providerId },
      });
      return { credits, entry };
    },

    /**
     * Spend credits for consumer storage usage. Deterministic and integer-safe.
     * Prevents negative balances.
     */
    recordConsumerUsage(
      consumerId: AccountId,
      bytesStored: number,
      durationMs: number,
      replicationFactor = 1,
      reason = "consumer.usage",
    ): { credits: CreditAmount; entry: LedgerEntry } {
      assertAccountId(consumerId);
      const credits = calculateConsumerCredits(bytesStored, durationMs, replicationFactor);
      if (credits === 0) {
        // Still auditable: record 0 spend as spend entry with amount 0? For now no entry for 0 to avoid noise.
        const acc = ensureAccount(consumerId);
        return {
          credits: 0,
          entry: appendEntry({
            accountId: consumerId,
            type: "spend",
            amount: 0,
            delta: 0,
            balanceAfter: acc.balance,
            reason,
            metadata: { bytes: bytesStored, durationMs, replicationFactor },
          }),
        };
      }
      const acc = ensureAccount(consumerId);
      if (acc.balance < credits) throw new Error(`insufficient balance: need ${credits}, have ${acc.balance}`);
      acc.balance -= credits;
      // totalSupply unchanged for spend (transfer not issuance). For internal model, spend reduces supply? Keep totalSupply as issued - spent? For now totalSupply tracks issued + earned, not net.
      // To keep auditable, we track totalSupply separately as sum of issuances+earns; spends do not reduce totalSupply (they are allocation).
      accounts.set(consumerId, { ...acc });
      const entry = appendEntry({
        accountId: consumerId,
        type: "spend",
        amount: credits,
        delta: -credits,
        balanceAfter: acc.balance,
        reason,
        metadata: { bytes: bytesStored, durationMs, replicationFactor },
      });
      return { credits, entry };
    },

    /**
     * Direct spend of explicit amount (for marketplace consumption).
     */
    spendCredits(consumerId: AccountId, amount: CreditAmount, reason = "spend"): LedgerEntry {
      assertAccountId(consumerId);
      assertCreditAmount(amount, "amount");
      if (amount === 0) throw new TypeError("amount must be >0");
      const acc = ensureAccount(consumerId);
      if (acc.balance < amount) throw new Error(`insufficient balance: need ${amount}, have ${acc.balance}`);
      acc.balance -= amount;
      accounts.set(consumerId, { ...acc });
      return appendEntry({
        accountId: consumerId,
        type: "spend",
        amount,
        delta: -amount,
        balanceAfter: acc.balance,
        reason,
      });
    },

    /**
     * Internal transfer between accounts — balanced, integer-safe, idempotent, atomic.
     * **Authority boundary:** This is an internal settlement primitive. Direct external use
     * would bypass settlement invariants (provider eligibility, amount determinism, settlement
     * status machine, audit semantics). Callers must go through `packages/settlement` which
     * validates `isMarketplaceEligible`, derives `amount` deterministically, checks
     * `consumerBalance`, and enforces `pending→finalized|rejected|failed` with append-only
     * settlement records. Direct calls are rejected unless `reason` starts with `settlement:` and
     * `eventId` (settlement id) is provided.
     * Provider credits and consumer debits balance: same `amount` debited from `fromId` and credited to `toId`.
     * `totalSupply` is unchanged (transfer, not issuance). Append-only, replay-safe via `eventId`, atomic.
     */
    transferCredits(
      fromId: AccountId,
      toId: AccountId,
      amount: CreditAmount,
      reason = "transfer",
      eventId?: string,
    ): { fromEntry: LedgerEntry; toEntry: LedgerEntry } | null {
      assertAccountId(fromId);
      assertAccountId(toId);
      if (fromId === toId) throw new TypeError("fromId and toId must differ");
      assertCreditAmount(amount, "amount");
      if (amount === 0) throw new TypeError("amount must be >0");
      if (eventId !== undefined && (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 256)) throw new TypeError("eventId must be non-empty string 1-256 if provided");
      // Authority boundary: only settlement layer may create transfers. Require explicit settlement reason + eventId.
      if (eventId === undefined || !reason.startsWith("settlement:")) {
        throw new Error("transferCredits is internal to settlement: use packages/settlement with settlement id and provider eligibility");
      }
      const transferKey = `transfer:${eventId}|${fromId}|${toId}|${amount}`;
      if (seenTransfers.has(transferKey)) {
        return null;
      }
      // Atomic validation before any mutation
      const fromAcc = accounts.get(fromId);
      const fromBalance = fromAcc ? fromAcc.balance : 0;
      if (fromBalance < amount) throw new Error(`insufficient balance: need ${amount}, have ${fromBalance}`);
      const toAcc = accounts.get(toId);
      const toBalance = toAcc ? toAcc.balance : 0;
      if (toBalance > Number.MAX_SAFE_INTEGER - amount) throw new RangeError("balance would exceed safe integer");
      // Atomic mutation + ledger append; rollback on any failure
      const ts = now();
      let fromEntry: LedgerEntry | undefined;
      let toEntry: LedgerEntry | undefined;
      const prevFrom = fromAcc ? { ...fromAcc } : undefined;
      const prevTo = toAcc ? { ...toAcc } : undefined;
      try {
        const newFrom: Account = { id: fromId, balance: fromBalance - amount, createdAt: fromAcc ? fromAcc.createdAt : ts };
        const newTo: Account = { id: toId, balance: toBalance + amount, createdAt: toAcc ? toAcc.createdAt : ts };
        accounts.set(fromId, newFrom);
        accounts.set(toId, newTo);
        fromEntry = appendEntry({
          timestamp: ts,
          accountId: fromId,
          type: "spend",
          amount,
          delta: -amount,
          balanceAfter: newFrom.balance,
          reason,
        });
        toEntry = appendEntry({
          timestamp: ts,
          accountId: toId,
          type: "earn",
          amount,
          delta: amount,
          balanceAfter: newTo.balance,
          reason,
        });
        seenTransfers.add(transferKey);
      } catch (e) {
        // Rollback balances and ledger on any failure (atomicity)
        if (prevFrom) accounts.set(fromId, prevFrom);
        else accounts.delete(fromId);
        if (prevTo) accounts.set(toId, prevTo);
        else accounts.delete(toId);
        // Remove ledger entries if one was appended before failure
        if (fromEntry) {
          const idx = ledger.findIndex((el) => el.id === fromEntry!.id);
          if (idx !== -1) ledger.splice(idx, 1);
          nextId--;
        }
        if (toEntry) {
          const idx = ledger.findIndex((el) => el.id === toEntry!.id);
          if (idx !== -1) ledger.splice(idx, 1);
          nextId--;
        }
        throw e;
      }
      return { fromEntry: fromEntry!, toEntry: toEntry! };
    },
  };
}

export type Economics = ReturnType<typeof createEconomics>;
