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

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createIdentity } from "../../packages/identity/index.js";
import { loadIdentity, saveIdentity } from "../../packages/identity/keystore.js";
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
  /**
   * Path of the encrypted keystore file enabling local identity
   * management (first-run creation + unlock). Absent → identity
   * endpoints report that management is not configured (demo mode).
   */
  keystorePath?: string;
}

/** Creation result: public metadata plus the phrase shown exactly once. */
export interface IdentityCreation {
  publicKey: string;
  recoveryPhrase: string[];
}

/** Unlock result: public metadata only, never private material. */
export interface IdentityUnlock {
  unlocked: boolean;
  publicKey: string;
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
  /**
   * Local identity status. Without `keystorePath` this reports that
   * management is not configured (demo mode).
   */
  getIdentityStatus(): Promise<WebIdentityStatus>;
  /**
   * First-run identity creation. Fails when management is not
   * configured or an identity already exists. The recovery phrase is
   * returned once for backup display and never persisted.
   */
  createIdentity(password: string): Promise<IdentityCreation>;
  /**
   * Verify a keystore password. Caches only public metadata
   * server-side; private material is wiped before returning.
   */
  unlockIdentity(password: string): Promise<IdentityUnlock>;
  /** Clear the server-side unlocked flag. */
  lockIdentity(): void;
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
  if (options.keystorePath !== undefined && (typeof options.keystorePath !== "string" || options.keystorePath === "")) {
    throw new TypeError("keystorePath must be a non-empty string");
  }
  const catalog = options.manifestDir ? createFileCatalog(createManifestStore({ dir: options.manifestDir })) : null;
  const registry = options.registry ?? null;
  const keystorePath = options.keystorePath ?? null;
  const status: BackendStatus = {
    demoMode: !catalog && !registry,
    manifestStore: catalog !== null,
    registry: registry !== null,
  };

  // Server-side unlock flag: public metadata only (base64 public key).
  // Private key material is never cached — unlock verifies, wipes, drops.
  let unlockedPublicKey: string | null = null;

  function assertPassword(password: unknown): asserts password is string {
    if (typeof password !== "string" || password === "") {
      throw new Error("a non-empty password is required");
    }
  }

  /** Public key from the keystore file, or null when absent/unreadable. */
  async function readKeystorePublicKey(): Promise<string | null> {
    if (!keystorePath) return null;
    let text: string;
    try {
      text = await readFile(keystorePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const pubkey = parsed["publicKey"];
      if (typeof pubkey !== "string" || pubkey === "" || pubkey.length > 256) return null;
      // Must be plausible base64; the real check happens at unlock time.
      if (!/^[A-Za-z0-9+/=]+$/.test(pubkey)) return null;
      return pubkey;
    } catch {
      return null;
    }
  }

  async function identityStatus(): Promise<WebIdentityStatus> {
    if (!keystorePath) {
      if (options.identityLabel) {
        return { configured: true, unlocked: false, label: options.identityLabel };
      }
      return { ...MOCK_IDENTITY };
    }
    const pubkey = await readKeystorePublicKey();
    if (!pubkey) {
      const exists = existsSync(keystorePath);
      return {
        configured: false,
        unlocked: false,
        label: exists ? "keystore file is malformed" : "no keystore found",
      };
    }
    const unlocked = unlockedPublicKey === pubkey;
    return {
      configured: true,
      unlocked,
      label: "local keystore",
      publicKey: pubkey,
    };
  }

  return {
    version: WEB_BACKEND_VERSION,
    status: { ...status },

    async getSnapshot(): Promise<BackendSnapshot> {
      const files = catalog ? await catalog.listEntries() : MOCK_FILES.map((f) => ({ ...f }));
      const nodes = registry ? registry.list().map(toWebNode) : MOCK_NODES.map((n) => ({ ...n }));
      const identity: WebIdentityStatus = keystorePath
        ? await identityStatus()
        : options.identityLabel
          ? { configured: true, unlocked: false, label: options.identityLabel }
          : catalog || registry
            ? { configured: false, unlocked: false, label: "no local identity linked" }
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

    async getIdentityStatus(): Promise<WebIdentityStatus> {
      if (!keystorePath) {
        if (options.identityLabel) {
          return { configured: true, unlocked: false, label: options.identityLabel };
        }
        return { ...MOCK_IDENTITY };
      }
      return identityStatus();
    },

    async createIdentity(password: string): Promise<IdentityCreation> {
      if (!keystorePath) {
        throw new Error("identity management is not configured on this server");
      }
      assertPassword(password);
      if (existsSync(keystorePath)) {
        throw new Error("identity already configured");
      }
      const identity = createIdentity();
      // Copy out what the caller needs BEFORE wiping private material.
      const publicKey = identity.publicKey.toString("base64");
      const recoveryPhrase = [...identity.recoveryPhrase];
      try {
        await saveIdentity(identity, password, keystorePath);
      } finally {
        // Private material never leaves this scope in usable form.
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
      }
      unlockedPublicKey = publicKey;
      // The phrase is returned once for backup display; never persisted
      // (saveIdentity ignores it) and never logged.
      return { publicKey, recoveryPhrase };
    },

    async unlockIdentity(password: string): Promise<IdentityUnlock> {
      if (!keystorePath) {
        throw new Error("identity management is not configured on this server");
      }
      assertPassword(password);
      const identity = await loadIdentity(password, keystorePath);
      try {
        const publicKey = identity.publicKey.toString("base64");
        unlockedPublicKey = publicKey;
        return { unlocked: true, publicKey };
      } finally {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
      }
    },

    lockIdentity(): void {
      unlockedPublicKey = null;
    },
  };
}
