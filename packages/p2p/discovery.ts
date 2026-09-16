import {
  type PeerDiscovery,
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

  constructor(private readonly bootstrapPeers: readonly P2PPeerDescriptor[] = []) {
    this.bootstrapPeers = bootstrapPeers.map(cloneAndValidate);
  }

  async start(local: P2PPeerDescriptor): Promise<void> {
    const descriptor = cloneAndValidate(local);
    this.started = true;
    this.localNodeId = descriptor.nodeId;
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
    if (this.localNodeId !== undefined) StaticPeerDiscovery.advertised.delete(this.localNodeId);
    this.localNodeId = undefined;
    this.started = false;
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
  };
}
