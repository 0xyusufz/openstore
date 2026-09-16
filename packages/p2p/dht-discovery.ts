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
} from "./index.js";

const RECORD_PREFIX = "openstore-peer-v1:";
const DHT_OPERATION_TIMEOUT_MS = 1_000;

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

  constructor(bootstrapPeers: readonly P2PPeerDescriptor[] = []) {
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
    return [...found.values()];
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
        const descriptor = decode(event.value);
        if (descriptor.nodeId !== nodeId) throw new Error("DHT record peer identity mismatch");
        return descriptor;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}

function recordKey(nodeId: string): Uint8Array {
  return new TextEncoder().encode(`${RECORD_PREFIX}${nodeId}`);
}

function encode(descriptor: P2PPeerDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(cloneAndValidate(descriptor)));
}

function decode(value: Uint8Array): P2PPeerDescriptor {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
  validateP2PPeerDescriptor(parsed);
  return cloneAndValidate(parsed);
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
