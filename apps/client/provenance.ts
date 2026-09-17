import { createHash } from "crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import type { StorageNodeEndpoint } from "./index.js";
import type { P2PNodeAddress, P2PProvenanceTransport, P2PTransport } from "../../packages/p2p/index.js";
import { HttpProvenanceTransport, MixedProvenanceTransport, MixedStorageTransport } from "./http-transport.js";
import { createOpaqueId, canTransitionOperation, validateOperationRecord, type DeleteIfUnclaimedResult, type OperationRecord, type OperationState, type PieceClaim, type PieceClaimKind } from "../../packages/provenance/index.js";
import { hashPieceId } from "../../packages/manifest/index.js";
import type { ManifestStore } from "../../packages/manifest/store.js";

export interface ProvenanceIdentity {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface OperationRecordStore {
  readonly dir: string;
  create(record: OperationRecord): Promise<OperationRecord>;
  update(operationId: string, state: OperationState): Promise<OperationRecord>;
  load(operationId: string): Promise<OperationRecord | undefined>;
  list(): Promise<OperationRecord[]>;
}

export function createOperationRecordStore(directory: string): OperationRecordStore {
  const dir = resolve(directory);
  const locks = new Map<string, Promise<void>>();
  const pathFor = (id: string) => join(dir, `${id}.json`);
  async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const queued = previous.then(() => current);
    locks.set(id, queued);
    await previous;
    try { return await fn(); } finally { release(); if (locks.get(id) === queued) locks.delete(id); }
  }
  async function read(id: string): Promise<OperationRecord | undefined> {
    try {
      const record = JSON.parse(await readFile(pathFor(id), "utf8")) as OperationRecord;
      validateOperationRecord(record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`malformed operation record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function write(record: OperationRecord): Promise<void> {
    validateOperationRecord(record);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.tmp.${createOpaqueId(16)}.json`);
    try {
      await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, pathFor(record.operationId));
    } catch (error) {
      try { await unlink(temp); } catch {}
      throw error;
    }
  }
  return {
    dir,
    create: (record) => withLock(record.operationId, async () => {
      const existing = await read(record.operationId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("operation ID conflict");
        return existing;
      }
      await write(record);
      return record;
    }),
    update: (operationId, state) => withLock(operationId, async () => {
      const current = await read(operationId);
      if (!current) throw new Error("operation record not found");
      if (!canTransitionOperation(current.state, state)) throw new Error(`invalid operation transition: ${current.state} -> ${state}`);
      const next = { ...current, state, updatedAt: Date.now() };
      await write(next);
      return next;
    }),
    load: read,
    async list() {
      let entries: string[];
      try { entries = await readdir(dir); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const records: OperationRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.startsWith(".tmp.")) continue;
        const record = await read(entry.slice(0, -5));
        if (record) records.push(record);
      }
      return records;
    },
  };
}

export function createOperationRecord(
  pieceId: string,
  claim: PieceClaim,
  targetNodeId: string,
  kind: PieceClaimKind,
  expectedManifestRevision: number,
): OperationRecord {
  const now = Date.now();
  return { operationId: claim.operationId, pieceId, claimId: claim.claimId, targetNodeId, kind, expectedManifestRevision, state: "prepared", createdAt: now, updatedAt: now };
}

export interface ProvenanceStoreReport {
  succeeded: StorageNodeEndpoint[];
  failed: { endpoint: StorageNodeEndpoint; error: string }[];
  claims: { endpoint: StorageNodeEndpoint; claim: PieceClaim; operation: OperationRecord }[];
}

export async function storePieceWithProvenance(
  pieceId: string,
  bytes: Buffer,
  endpoints: StorageNodeEndpoint[],
  identity: ProvenanceIdentity,
  operationStore: OperationRecordStore,
  options: { timeoutMs: number; transport?: P2PProvenanceTransport; storageTransport?: P2PTransport; expectedManifestRevision: number; kind: PieceClaimKind },
): Promise<ProvenanceStoreReport> {
  if (hashPieceId(bytes) !== pieceId) throw new Error("piece bytes do not match piece ID");
  const succeeded: StorageNodeEndpoint[] = [];
  const failed: { endpoint: StorageNodeEndpoint; error: string }[] = [];
  const claims: ProvenanceStoreReport["claims"] = [];
  for (const endpoint of endpoints) {
    const claim = createPieceClaim(pieceId, options.kind, identity);
    const operation = createOperationRecord(pieceId, claim, endpoint.id, options.kind, options.expectedManifestRevision);
    try {
      await createClaimOnNode(endpoint, claim, identity, options);
      await operationStore.create(operation);
      await storeClaimedPieceOnNode(endpoint, pieceId, claim.claimId, bytes, identity, options);
      await operationStore.update(operation.operationId, "stored");
      const address = toAddress(endpoint);
      const storageTransport = options.storageTransport ?? new MixedStorageTransport();
      const result = await storageTransport.getPiece(address, pieceId, { timeoutMs: options.timeoutMs });
      if (result.status !== 200 || !result.bytes || result.bytes.length !== bytes.length || !result.bytes.equals(bytes) || hashPieceId(result.bytes) !== pieceId) {
        throw new Error("provenance piece verification failed");
      }
      await operationStore.update(operation.operationId, "verified");
      succeeded.push(endpoint);
      claims.push({ endpoint, claim, operation: { ...operation, state: "verified", updatedAt: Date.now() } });
    } catch (error) {
      failed.push({ endpoint, error: error instanceof Error ? error.message : String(error) });
      try {
        await releaseClaimOnNode(endpoint, pieceId, claim.claimId, identity, options);
        try {
          await operationStore.update(operation.operationId, "release-requested");
          await operationStore.update(operation.operationId, "released");
        } catch {
          // The claim release succeeded; an absent/uncertain local record is
          // repaired by the next durable reconciliation pass.
        }
      } catch {
        // Uncertainty is retained at the node; no deletion is attempted.
      }
    }
  }
  return { succeeded, failed, claims };
}

export async function markProvenanceCommitted(
  placements: ProvenanceStoreReport["claims"],
  identity: ProvenanceIdentity,
  options: { timeoutMs: number; transport?: P2PProvenanceTransport },
  operationStore: OperationRecordStore,
): Promise<void> {
  for (const placement of placements) {
    await markClaimReferencedOnNode(placement.endpoint, placement.claim.pieceId, placement.claim.claimId, identity, options);
    await operationStore.update(placement.operation.operationId, "committed");
  }
}

export async function releaseProvenancePlacements(
  placements: ProvenanceStoreReport["claims"],
  identity: ProvenanceIdentity,
  options: { timeoutMs: number; transport?: P2PProvenanceTransport },
  operationStore: OperationRecordStore,
): Promise<void> {
  for (const placement of placements) {
    try {
      await operationStore.update(placement.operation.operationId, "release-requested");
      await releaseClaimOnNode(placement.endpoint, placement.claim.pieceId, placement.claim.claimId, identity, options);
      await operationStore.update(placement.operation.operationId, "released");
    } catch {
      // Keep the claim and operation for restart reconciliation when uncertain.
    }
  }
}

export async function reconcileCommittedOperation(
  fileId: string,
  record: OperationRecord,
  manifestStore: ManifestStore,
  endpoints: StorageNodeEndpoint[],
  identity: ProvenanceIdentity,
  operationStore: OperationRecordStore,
  options: { timeoutMs: number; transport?: P2PProvenanceTransport },
): Promise<OperationRecord> {
  const snapshot = await manifestStore.loadWithRevision(fileId).catch(() => undefined);
  const manifest = snapshot?.manifest;
  const represented = manifest?.chunks.some((chunk) =>
    chunk.pieceId === record.pieceId && chunk.nodeIds.includes(record.targetNodeId),
  ) ?? false;
  if (!represented) return record;
  const endpoint = endpoints.find((candidate) => candidate.id === record.targetNodeId);
  if (!endpoint) return record;
  await markClaimReferencedOnNode(endpoint, record.pieceId, record.claimId, identity, options);
  if (record.state === "verified") return operationStore.update(record.operationId, "committed");
  return record;
}

export function clientNamespace(identity: ProvenanceIdentity): string {
  return createHash("sha256").update(identity.publicKey).digest("hex");
}

export function createPieceClaim(
  pieceId: string,
  kind: PieceClaimKind,
  identity: ProvenanceIdentity,
  operationId = createOpaqueId(),
  claimId = createOpaqueId(),
): PieceClaim {
  const now = Date.now();
  return {
    pieceId,
    claimId,
    operationId,
    clientNamespace: clientNamespace(identity),
    kind,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export async function createClaimOnNode(node: StorageNodeEndpoint, claim: PieceClaim, identity: ProvenanceIdentity, options: { timeoutMs: number; transport?: P2PProvenanceTransport } ): Promise<PieceClaim> {
  return (options.transport ?? new MixedProvenanceTransport(new HttpProvenanceTransport(identity))).createClaim(toAddress(node), claim, options);
}

export async function storeClaimedPieceOnNode(node: StorageNodeEndpoint, pieceId: string, claimId: string, data: Buffer, identity: ProvenanceIdentity, options: { timeoutMs: number; transport?: P2PProvenanceTransport }): Promise<void> {
  return (options.transport ?? new MixedProvenanceTransport(new HttpProvenanceTransport(identity))).storeClaimedPiece(toAddress(node), pieceId, claimId, data, options);
}

export async function markClaimReferencedOnNode(node: StorageNodeEndpoint, pieceId: string, claimId: string, identity: ProvenanceIdentity, options: { timeoutMs: number; transport?: P2PProvenanceTransport }): Promise<PieceClaim> {
  return (options.transport ?? new MixedProvenanceTransport(new HttpProvenanceTransport(identity))).markClaimReferenced(toAddress(node), pieceId, claimId, options);
}

export async function releaseClaimOnNode(node: StorageNodeEndpoint, pieceId: string, claimId: string, identity: ProvenanceIdentity, options: { timeoutMs: number; transport?: P2PProvenanceTransport }): Promise<PieceClaim> {
  return (options.transport ?? new MixedProvenanceTransport(new HttpProvenanceTransport(identity))).releaseClaim(toAddress(node), pieceId, claimId, clientNamespace(identity), options);
}

export async function deletePieceIfUnclaimedOnNode(node: StorageNodeEndpoint, pieceId: string, identity: ProvenanceIdentity, options: { timeoutMs: number; transport?: P2PProvenanceTransport }): Promise<DeleteIfUnclaimedResult> {
  return (options.transport ?? new MixedProvenanceTransport(new HttpProvenanceTransport(identity))).deletePieceIfUnclaimed(toAddress(node), pieceId, options);
}

function toAddress(endpoint: StorageNodeEndpoint): P2PNodeAddress {
  return {
    nodeId: endpoint.id,
    baseUrl: endpoint.baseUrl,
    ...(endpoint.multiaddr === undefined ? {} : { multiaddr: endpoint.multiaddr }),
    ...(endpoint.identityBinding === undefined ? {} : { identityBinding: endpoint.identityBinding }),
    ...(endpoint.identity === undefined ? {} : { identity: endpoint.identity }),
  };
}
