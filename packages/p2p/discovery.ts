import {
  type PeerDiscovery,
  type PeerDiscoveryOptions,
  type P2PPeerDescriptor,
  validateP2PPeerDescriptor,
} from "./index.js";

/**
 * Deterministic in-process discovery for the MVP. It models bootstrap
 * advertising without claiming global discovery or DHT support.
 */
export class StaticPeerDiscovery implements PeerDiscovery {
  private static readonly advertised = new Map<string, P2PPeerDescriptor>();
  private started = false;
  private localNodeId?: string;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshOptions?: PeerDiscoveryOptions;

  constructor(private readonly bootstrapPeers: readonly P2PPeerDescriptor[] = []) {
    this.bootstrapPeers = bootstrapPeers.map(cloneAndValidate);
  }

  async start(local: P2PPeerDescriptor, options: PeerDiscoveryOptions = {}): Promise<void> {
    const descriptor = cloneAndValidate(local);
    if (this.started) return;
    if (options.refreshIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.refreshIntervalMs) || options.refreshIntervalMs <= 0)) {
      throw new TypeError("peer discovery refresh interval must be a positive safe integer");
    }
    this.started = true;
    this.localNodeId = descriptor.nodeId;
    this.refreshOptions = options;
    await this.refresh();
  }

  async advertise(local: P2PPeerDescriptor): Promise<void> {
    if (!this.started) throw new Error("peer discovery is not started");
    const descriptor = cloneAndValidate(local);
    StaticPeerDiscovery.advertised.set(descriptor.nodeId, descriptor);
    this.localNodeId = descriptor.nodeId;
  }

  async discover(): Promise<readonly P2PPeerDescriptor[]> {
    if (!this.started) throw new Error("peer discovery is not started");
    const peers = [...this.bootstrapPeers, ...StaticPeerDiscovery.advertised.values()]
      .filter((peer) => peer.nodeId !== this.localNodeId)
      .map(cloneAndValidate);
    const unique = new Map(peers.map((peer) => [peer.nodeId, peer]));
    return [...unique.values()];
  }

  async stop(): Promise<void> {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.localNodeId !== undefined) StaticPeerDiscovery.advertised.delete(this.localNodeId);
    this.localNodeId = undefined;
    this.refreshOptions = undefined;
    this.started = false;
  }

  private async refresh(): Promise<void> {
    if (!this.started) return;
    try {
      const peers = await this.discover();
      await this.refreshOptions?.onRefresh?.(peers);
    } catch {
      // A failed discovery pass must not terminate future refreshes.
    } finally {
      if (this.started && this.refreshOptions?.refreshIntervalMs !== undefined) {
        const interval = this.refreshOptions.refreshIntervalMs;
        if (Number.isFinite(interval) && interval > 0) {
          this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
          }, interval);
        }
      }
    }
  }
}

function cloneAndValidate(value: P2PPeerDescriptor): P2PPeerDescriptor {
  validateP2PPeerDescriptor(value);
  return {
    nodeId: value.nodeId,
    baseUrl: value.baseUrl,
    identity: { publicKey: value.identity.publicKey },
    capabilities: { ...value.capabilities },
    ...(value.multiaddr === undefined ? {} : { multiaddr: value.multiaddr }),
    ...(value.identityBinding === undefined ? {} : { identityBinding: value.identityBinding }),
  };
}
