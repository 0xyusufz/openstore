import { kadDHT, type KadDHT } from "@libp2p/kad-dht";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import type { Libp2p } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import {
  type PeerDiscovery,
  type PeerDiscoveryOptions,
  type P2PPeerDescriptor,
  validateP2PPeerDescriptor,
  type OpenStoreDhtRecord,
} from "./index.js";
import { defaultMetrics, type MetricsRegistry } from "../metrics/index.js";

const RECORD_PREFIX = "openstore-peer-v1:";
const DHT_OPERATION_TIMEOUT_MS = 1_000;
const DHT_MAX_RECORD_AGE_MS = 5 * 60_000;
const DHT_CLOCK_SKEW_MS = 30_000;

export type DhtPeerTrustState = "fresh" | "stale" | "invalid" | "unavailable";
export interface DhtTrustResult {
  state: DhtPeerTrustState;
  descriptor?: P2PPeerDescriptor;
  ageMs?: number;
}

export interface DhtPeerDiscoveryOptions {
  metrics?: MetricsRegistry;
}

type DhtNode = Libp2p<{ dht: KadDHT }>;

export function createDhtServices(): {
  dht: ReturnType<typeof kadDHT>;
  identify: ReturnType<typeof identify>;
  ping: ReturnType<typeof ping>;
} {
  return {
    dht: kadDHT({ clientMode: false }),
    identify: identify(),
    ping: ping(),
  };
}

export class DhtPeerDiscovery implements PeerDiscovery {
  private node?: DhtNode;
  private local?: P2PPeerDescriptor;
  private started = false;
  private bootstrapPeers: readonly P2PPeerDescriptor[];
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshOptions?: PeerDiscoveryOptions;
  private lastPeerIds = new Set<string>();
  private refreshPromise?: Promise<void>;

  private readonly metrics: MetricsRegistry;

  constructor(bootstrapPeers: readonly P2PPeerDescriptor[] = [], options: DhtPeerDiscoveryOptions = {}) {
    this.metrics = options.metrics ?? defaultMetrics;
    this.bootstrapPeers = bootstrapPeers.map(cloneAndValidate);
  }

  attach(node: DhtNode): void {
    if (this.started) throw new Error("cannot attach a running peer discovery provider");
    this.node = node;
  }

  addBootstrapPeer(peer: P2PPeerDescriptor): void {
    const descriptor = cloneAndValidate(peer);
    this.bootstrapPeers = [...this.bootstrapPeers, descriptor]
      .filter((candidate, index, peers) => peers.findIndex((item) => item.nodeId === candidate.nodeId) === index);
  }

  async refreshNow(options: PeerDiscoveryOptions = {}): Promise<void> {
    if (!this.started) throw new Error("peer discovery is not started");
    return this.refreshPromise ??= this.refresh(options).finally(() => { this.refreshPromise = undefined; });
  }

  async start(local: P2PPeerDescriptor, options: PeerDiscoveryOptions = {}): Promise<void> {
    if (this.started) return;
    if (this.node === undefined) throw new Error("DHT peer discovery requires an attached libp2p node");
    const descriptor = cloneAndValidate(local);
    this.local = descriptor;
    this.started = true;
    this.refreshOptions = options;
    try {
      await this.connectBootstrapPeers();
      await this.advertise(descriptor);
      await this.refreshNow(options);
    } catch {
      // Bootstrap and DHT record failures are isolated from node startup.
      await this.refreshNow(options);
    }
  }

  async advertise(local: P2PPeerDescriptor): Promise<void> {
    if (!this.started || this.node === undefined) throw new Error("peer discovery is not started");
    const descriptor = cloneAndValidate(local);
    this.local = descriptor;
    const dht = this.node.services.dht;
    try {
      for await (const _ of dht.put(recordKey(descriptor.nodeId), encode(descriptor), {
        signal: AbortSignal.timeout(DHT_OPERATION_TIMEOUT_MS),
      })) {
        // Consume the query so the record is fully published.
      }
    } catch {
      // A node can advertise locally before any DHT route is available.
    }
  }

  async discover(): Promise<readonly P2PPeerDescriptor[]> {
    if (!this.started || this.node === undefined) throw new Error("peer discovery is not started");
    const found = new Map<string, P2PPeerDescriptor>();
    for (const bootstrap of this.bootstrapPeers) {
      if (bootstrap.nodeId === this.local?.nodeId) continue;
      try {
        const record = await this.getRecord(bootstrap.nodeId);
        if (record !== undefined && record.nodeId !== this.local?.nodeId) found.set(record.nodeId, record);
      } catch {
        // An unreachable or missing bootstrap record is not fatal.
      }
    }
    return deduplicateDhtDescriptors([...found.values()]);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.started = false;
    this.local = undefined;
    this.node = undefined;
    this.refreshOptions = undefined;
    this.lastPeerIds.clear();
  }

  private async refresh(options: PeerDiscoveryOptions): Promise<void> {
    try {
      const peers = await this.discover();
      const current = new Set(peers.map((peer) => peer.nodeId));
      const removed = [...this.lastPeerIds].filter((nodeId) => !current.has(nodeId));
      this.lastPeerIds = current;
      await options.onRefresh?.(peers);
      if (removed.length > 0) await options.onPeerRemoved?.(removed);
    } catch {
      // A failed query must not stop future refreshes.
    } finally {
      if (this.started && options.refreshIntervalMs !== undefined) {
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.refreshNow(options);
        }, options.refreshIntervalMs);
      }
    }
  }

  private async connectBootstrapPeers(): Promise<void> {
    if (this.node === undefined) return;
    for (const peer of this.bootstrapPeers) {
      if (peer.multiaddr === undefined || peer.nodeId === this.node.peerId.toString()) continue;
      try {
        await this.node.dial(multiaddr(peer.multiaddr), {
          signal: AbortSignal.timeout(DHT_OPERATION_TIMEOUT_MS),
        });
      } catch {
        // DHT can continue with any reachable bootstrap peers.
      }
    }
  }

  private async getRecord(nodeId: string): Promise<P2PPeerDescriptor | undefined> {
    if (this.node === undefined) return undefined;
    try {
      for await (const event of this.node.services.dht.get(recordKey(nodeId), {
        signal: AbortSignal.timeout(DHT_OPERATION_TIMEOUT_MS),
      })) {
        if (event.name !== "VALUE") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(event.value));
        } catch {
          this.recordRejection("invalid");
          continue;
        }
        const trust = classifyDhtRecord(parsed);
        if (trust.state !== "fresh" || trust.descriptor === undefined) {
          this.recordRejection(trust.state === "stale" ? "stale" : "invalid");
          continue;
        }
        const descriptor = trust.descriptor;
        if (descriptor.nodeId !== nodeId) throw new Error("DHT record peer identity mismatch");
        return descriptor;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private recordRejection(reason: "stale" | "invalid"): void {
    try { this.metrics.increment("dht_record_rejections_total", 1, { reason }); } catch {}
  }
}

function recordKey(nodeId: string): Uint8Array {
  return new TextEncoder().encode(`${RECORD_PREFIX}${nodeId}`);
}

function encode(descriptor: P2PPeerDescriptor): Uint8Array {
  const record = createDhtRecord(descriptor);
  return new TextEncoder().encode(JSON.stringify(record));
}

export function createDhtRecord(descriptor: P2PPeerDescriptor, publishedAt = Date.now()): OpenStoreDhtRecord {
  const record: OpenStoreDhtRecord = { version: 1, publishedAt, descriptor: cloneAndValidate(descriptor) };
  validateDhtRecord(record);
  return Object.freeze({ ...record, descriptor: Object.freeze({ ...record.descriptor, identity: Object.freeze({ ...record.descriptor.identity }), capabilities: Object.freeze({ ...record.descriptor.capabilities }) }) });
}

/** Deterministically keeps the first fresh descriptor for each peer identity. */
export function deduplicateDhtDescriptors(peers: readonly P2PPeerDescriptor[]): P2PPeerDescriptor[] {
  const seen = new Set<string>();
  const result: P2PPeerDescriptor[] = [];
  for (const peer of peers) {
    const descriptor = cloneAndValidate(peer);
    if (seen.has(descriptor.nodeId)) continue;
    seen.add(descriptor.nodeId);
    result.push(descriptor);
  }
  return result;
}

export function classifyDhtRecord(value: unknown, now = Date.now()): DhtTrustResult {
  try {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid observation time");
    validateDhtRecord(value);
    const record = value as OpenStoreDhtRecord;
    const ageMs = now - record.publishedAt;
    if (ageMs < -DHT_CLOCK_SKEW_MS) return { state: "invalid", ageMs };
    if (ageMs > DHT_MAX_RECORD_AGE_MS) return { state: "stale", ageMs };
    return { state: "fresh", ageMs, descriptor: cloneAndValidate(record.descriptor) };
  } catch {
    return { state: "invalid" };
  }
}

function validateDhtRecord(value: unknown): asserts value is OpenStoreDhtRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("DHT record must be an object");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Number.isSafeInteger(record.publishedAt) || (record.publishedAt as number) < 0) {
    throw new TypeError("DHT record metadata is invalid");
  }
  validateP2PPeerDescriptor(record.descriptor);
  cloneAndValidate(record.descriptor as P2PPeerDescriptor);
}

function cloneAndValidate(value: P2PPeerDescriptor): P2PPeerDescriptor {
  validateP2PPeerDescriptor(value);
  if (value.identityBinding === undefined) {
    throw new TypeError("DHT peer descriptor requires an identity binding");
  }
  return {
    nodeId: value.nodeId,
    baseUrl: value.baseUrl,
    identity: { publicKey: value.identity.publicKey },
    capabilities: { ...value.capabilities },
    ...(value.multiaddr === undefined ? {} : { multiaddr: value.multiaddr }),
    ...(value.identityBinding === undefined ? {} : { identityBinding: value.identityBinding }),
  };
}
