/**
 * OpenStore Web Backend Boundary (OPENSTORE-024)
 *
 * Small typed layer connecting the dashboard to real client/library
 * functionality without duplicating business logic:
 * - File catalog comes from ManifestStore via FileCatalog (validated,
 *   malformed entries skipped — same behavior as the CLI).
 * - Storage-node status comes from Registry discovery, projected onto
 *   the UI-safe WebNode subset (no signatures, nonces, or keys).
 * - With nothing configured, every source falls back to explicit demo
 *   data (see src/mock.ts). The UI always knows which source it shows.
 *
 * Safety: snapshots expose safe metadata only. Private keys, recovery
 * phrases, encryption keys, passwords, plaintext, and piece bytes can
 * never pass this boundary — the underlying types simply lack them.
 * Real uploads/downloads are NOT implemented here (next milestone).
 */

import { createFileCatalog } from "../client/catalog.js";
import type { CatalogEntry } from "../client/catalog.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import type { Registry } from "../../packages/registry/index.js";
import { MOCK_FILES, MOCK_IDENTITY, MOCK_NODES } from "./src/mock.js";
import { toWebNode } from "./src/types.js";
import type { WebIdentityStatus, WebNode } from "./src/types.js";

export const WEB_BACKEND_VERSION = 1;

export type DataSource = "live" | "demo";

export interface WebBackendOptions {
  /** Directory holding persisted manifests. Absent → demo file catalog. */
  manifestDir?: string;
  /** Node registry for discovery. Absent → demo node list. */
  registry?: Registry;
  /**
   * Human label for a linked local identity (presence only, e.g. a
   * truncated public key). Secrets must never be passed here.
   */
  identityLabel?: string;
}

export interface BackendSnapshot {
  files: CatalogEntry[];
  nodes: WebNode[];
  identity: WebIdentityStatus;
  filesSource: DataSource;
  nodesSource: DataSource;
}

export interface BackendStatus {
  demoMode: boolean;
  manifestStore: boolean;
  registry: boolean;
}

export interface BackendHealth {
  status: "ok";
  app: "openstore-web";
  version: number;
  demoMode: boolean;
  backend: BackendStatus;
}

export interface WebBackend {
  readonly version: number;
  readonly status: BackendStatus;
  getSnapshot(): Promise<BackendSnapshot>;
  getHealth(): BackendHealth;
}

export function createWebBackend(options: WebBackendOptions = {}): WebBackend {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (options.manifestDir !== undefined && (typeof options.manifestDir !== "string" || options.manifestDir === "")) {
    throw new TypeError("manifestDir must be a non-empty string");
  }
  if (options.identityLabel !== undefined && typeof options.identityLabel !== "string") {
    throw new TypeError("identityLabel must be a string");
  }
  const catalog = options.manifestDir ? createFileCatalog(createManifestStore({ dir: options.manifestDir })) : null;
  const registry = options.registry ?? null;
  const status: BackendStatus = {
    demoMode: !catalog && !registry,
    manifestStore: catalog !== null,
    registry: registry !== null,
  };

  return {
    version: WEB_BACKEND_VERSION,
    status: { ...status },

    async getSnapshot(): Promise<BackendSnapshot> {
      const files = catalog ? await catalog.listEntries() : MOCK_FILES.map((f) => ({ ...f }));
      const nodes = registry ? registry.list().map(toWebNode) : MOCK_NODES.map((n) => ({ ...n }));
      const identity: WebIdentityStatus = options.identityLabel
        ? { configured: true, label: options.identityLabel }
        : catalog || registry
          ? { configured: false, label: "no local identity linked" }
          : { ...MOCK_IDENTITY };
      return {
        files,
        nodes,
        identity,
        filesSource: catalog ? "live" : "demo",
        nodesSource: registry ? "live" : "demo",
      };
    },

    getHealth(): BackendHealth {
      return {
        status: "ok",
        app: "openstore-web",
        version: WEB_BACKEND_VERSION,
        demoMode: status.demoMode,
        backend: { ...status },
      };
    },
  };
}
