/**
 * Standalone libp2p storage-node runtime (Milestone 040).
 *
 * This module deliberately has no HTTP server.  It is the process entry point
 * for nodes which expose the same opaque piece store over libp2p.
 */
import { mkdir, readFile, stat, unlink, writeFile, readdir } from "fs/promises";
import { join, resolve } from "path";
import type { Identity } from "../../packages/identity/index.js";
import { loadIdentity } from "../../packages/identity/keystore.js";
import { DhtPeerDiscovery } from "../../packages/p2p/dht-discovery.js";
import type { P2PPeerDescriptor } from "../../packages/p2p/index.js";
import { createLibp2pStorageNode, type Libp2pStorageNode } from "../../packages/p2p/libp2p.js";
import { isValidPieceId } from "./index.js";

export interface Libp2pStorageNodeRuntimeConfig {
  storageDir: string;
  identityPath: string;
  identityPassword: string;
  listenAddrs?: string[];
  bootstrapPeers?: P2PPeerDescriptor[];
  capacityBytes?: number;
  maxPieceBytes?: number;
  discoveryRefreshIntervalMs?: number;
}

export interface Libp2pStorageNodeRuntime {
  readonly identity: Identity;
  readonly node: Libp2pStorageNode;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function validateLibp2pStorageNodeRuntimeConfig(
  config: unknown,
): asserts config is Libp2pStorageNodeRuntimeConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("runtime config must be an object");
  const value = config as Record<string, unknown>;
  for (const field of ["storageDir", "identityPath", "identityPassword"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.listenAddrs !== undefined && (!Array.isArray(value.listenAddrs) || value.listenAddrs.length === 0 || value.listenAddrs.some((x) => typeof x !== "string" || x.length === 0))) {
    throw new TypeError("listenAddrs must be a non-empty string array");
  }
  if (value.bootstrapPeers !== undefined && (!Array.isArray(value.bootstrapPeers))) throw new TypeError("bootstrapPeers must be an array");
  for (const field of ["capacityBytes", "maxPieceBytes", "discoveryRefreshIntervalMs"]) {
    const n = value[field];
    if (n !== undefined && (!Number.isSafeInteger(n) || (n as number) <= 0)) throw new TypeError(`${field} must be a positive safe integer`);
  }
}

export async function createLibp2pStorageNodeRuntime(
  input: Libp2pStorageNodeRuntimeConfig,
): Promise<Libp2pStorageNodeRuntime> {
  validateLibp2pStorageNodeRuntimeConfig(input);
  const identity = await loadIdentity(input.identityPassword, resolve(input.identityPath));
  const storageDir = resolve(input.storageDir);
  await mkdir(storageDir, { recursive: true });
  const capacity = input.capacityBytes ?? 1 * 1024 * 1024 * 1024;
  const store = createPieceStore(storageDir, capacity, input.maxPieceBytes);
  const discovery = new DhtPeerDiscovery(input.bootstrapPeers ?? []);
  const node = await createLibp2pStorageNode({
    applicationIdentity: { publicKey: identity.publicKey.toString("base64") },
    applicationPrivateKey: identity.privateKey,
    listenAddrs: input.listenAddrs,
    maxPieceBytes: input.maxPieceBytes,
    allocatedBytes: capacity,
    availableBytes: capacity,
    discovery,
    discoveryRefreshIntervalMs: input.discoveryRefreshIntervalMs,
    storePiece: store.store,
    getPiece: store.get,
    deletePiece: store.remove,
  });
  return {
    identity,
    node,
    async start() { await node.start(); },
    async stop() { await node.stop(); },
  };
}

function createPieceStore(dir: string, capacity: number, maxPieceBytes?: number) {
  const pathFor = (id: string) => {
    if (!isValidPieceId(id)) throw new Error("invalid piece id");
    return join(dir, id);
  };
  const used = async () => {
    let total = 0;
    for (const name of await readdir(dir)) {
      try { const item = await stat(join(dir, name)); if (item.isFile()) total += item.size; } catch { /* concurrent deletion */ }
    }
    return total;
  };
  return {
    async store(id: string, data: Buffer) {
      if (maxPieceBytes !== undefined && data.length > maxPieceBytes) return 413;
      const path = pathFor(id);
      let previous = 0;
      let existed = false;
      try { previous = (await stat(path)).size; existed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const current = await used();
      if (current - previous + data.length > capacity) return 507;
      await writeFile(path, data, { mode: 0o600 });
      return existed ? 200 : 201;
    },
    async get(id: string) {
      try { return await readFile(pathFor(id)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(id: string) {
      try { await unlink(pathFor(id)); return 204; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 404;
        throw error;
      }
    },
  };
}
