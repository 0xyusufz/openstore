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
 * Real uploads go through the encrypted client pipeline here
 * (OPENSTORE-027); downloads land in a later milestone.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createIdentity, recoverIdentity } from "../../packages/identity/index.js";
import { loadIdentity, saveIdentity } from "../../packages/identity/keystore.js";
import { createManifestStore, isValidManifestFileId } from "../../packages/manifest/store.js";
import type { ManifestStore } from "../../packages/manifest/store.js";
import { createFileCatalog } from "../client/catalog.js";
import type { CatalogEntry } from "../client/catalog.js";
import { uploadBuffer } from "../client/upload.js";
import { downloadBuffer } from "../client/download.js";
import { createProviderManager } from "./provider.js";
import type { ProviderManager, ProviderStatus } from "./provider.js";

export type { ProviderManager, ProviderStatus } from "./provider.js";
import { createDekStore } from "./dekstore.js";
import type { DekStore } from "./dekstore.js";
import type { StorageNodeEndpoint } from "../client/index.js";
import type { Registry } from "../../packages/registry/index.js";
import { MOCK_FILES, MOCK_IDENTITY, MOCK_NODES } from "./src/mock.js";
import { toWebNode } from "./src/types.js";
import type { WebIdentityStatus, WebNode } from "./src/types.js";

export const WEB_BACKEND_VERSION = 1;

/**
 * Maximum accepted upload size (100 MiB). Enforced in the web backend
 * as defense-in-depth; the HTTP layer enforces the same limit while
 * streaming so oversized bodies are rejected before buffering.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Maximum stored filename length after sanitization. */
export const MAX_FILENAME_LENGTH = 255;

/**
 * Sanitize an upload filename so it can never escape into paths or
 * carry control characters into manifests/catalogs.
 *
 * - Takes the basename (strips any directory components, defeating
 *   `../`, absolute paths, and Windows drive segments).
 * - Rejects null bytes, empty results, and `.`/`..`.
 * - Replaces C0/C1 control characters and DEL with `_`.
 * - Truncates to {@link MAX_FILENAME_LENGTH} characters.
 *
 * @throws If the filename is not a string or sanitizes to nothing usable.
 */
export function sanitizeUploadFilename(filename: unknown): string {
  if (typeof filename !== "string") {
    throw new Error("invalid filename: must be a string");
  }
  if (filename.includes("\0")) {
    throw new Error("invalid filename: null bytes are not allowed");
  }
  // Basename: drop everything up to the last / or \ (path traversal,
  // absolute paths, drive letters all collapse to a bare name).
  const segments = filename.split(/[/\\]/);
  let base = segments[segments.length - 1] ?? "";
  // Strip header-injection leftovers and surrounding whitespace.
  base = base.replace(/[\r\n]/g, "").trim();
  if (base === "" || base === "." || base === "..") {
    throw new Error("invalid filename: name is empty after sanitization");
  }
  // Replace control characters (they corrupt displays/logs and can
  // smuggle terminal escapes) with a harmless placeholder.
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001F\u007F-\u009F]/g, "_");
  if (base === "" || base === "." || base === "..") {
    throw new Error("invalid filename: name is empty after sanitization");
  }
  if (base.length > MAX_FILENAME_LENGTH) {
    base = base.slice(0, MAX_FILENAME_LENGTH);
  }
  if (base.includes("/") || base.includes("\\")) {
    throw new Error("invalid filename: path separators are not allowed");
  }
  return base;
}

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
  /**
   * Path of the server-side DEK vault file holding per-file encryption
   * keys for web uploads (0o600, never served). Defaults to a sibling
   * of `manifestDir` (`<manifestDir>.deks.json`) so it stays invisible
   * to the manifest catalog. Only used when `manifestDir` is set.
   */
  dekPath?: string;
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

/** Recovery result: public metadata only, never private material. */
export interface IdentityRecovery {
  publicKey: string;
}

export interface BackendSnapshot {
  files: CatalogEntry[];
  nodes: WebNode[];
  identity: WebIdentityStatus;
  filesSource: DataSource;
  nodesSource: DataSource;
  /**
   * Storage provider status (Share Storage). Null when unconfigured or
   * in demo mode. Optional so older snapshot literals keep compiling;
   * readers must treat undefined as unconfigured.
   */
  provider?: ProviderStatus | null;
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

export interface UploadFileResult {
  fileId: string;
  filename: string;
  size: number;
  totalChunks: number;
}

/**
 * Download result: reconstructed file bytes plus safe metadata.
 * The file DEK is consumed server-side and never included.
 */
export interface DownloadFileResult {
  fileId: string;
  filename: string;
  size: number;
  data: Buffer;
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
  /**
   * Recover an identity from a 12-word recovery phrase and persist it
   * under a new password. If a keystore already exists, `confirmReplace`
   * must be true or the call is rejected (409). Private material is
   * wiped before returning.
   */
  recoverIdentity(
    phrase: string[],
    password: string,
    confirmReplace?: boolean,
  ): Promise<IdentityRecovery>;
  /**
   * Upload a file through the encrypted upload pipeline.
   * Returns safe metadata only; the encryption key never surfaces.
   */
  uploadFile(filename: string, data: Buffer): Promise<UploadFileResult>;
  /**
   * Download a file: fetch the manifest, resolve piece replicas, verify
   * integrity, decrypt with the vaulted file DEK, and reconstruct the
   * original bytes. Fails closed (no partial/corrupt bytes returned).
   * The DEK never leaves the server; only file bytes + safe metadata
   * are returned to the owning browser.
   */
  downloadFile(fileId: string): Promise<DownloadFileResult>;
  /**
   * Storage provider lifecycle (Share Storage). Always present; reports
   * unconfigured when the backend has no manifest store, and mutating
   * calls fail clearly without a registry.
   */
  readonly provider: ProviderManager;
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
  if (options.dekPath !== undefined && (typeof options.dekPath !== "string" || options.dekPath === "")) {
    throw new TypeError("dekPath must be a non-empty string");
  }
  const catalog = options.manifestDir ? createFileCatalog(createManifestStore({ dir: options.manifestDir })) : null;
  const registry = options.registry ?? null;
  const keystorePath = options.keystorePath ?? null;
  // Provider config lives next to the manifests (sibling file, invisible
  // to the catalog) and shares this backend's registry, so the UI's Live
  // mode and upload/download selection all see the same real nodes.
  const provider = createProviderManager({
    configPath: options.manifestDir ? `${options.manifestDir}.provider.json` : null,
    registry,
  });
  // The DEK vault lives alongside the manifests (sibling file, never
  // inside the manifest directory) and only exists for live backends.
  const dekStore: DekStore | null = options.manifestDir
    ? createDekStore({ path: options.dekPath ?? `${options.manifestDir}.deks.json` })
    : null;
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
    provider,

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
        provider: await provider.getStatus(),
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

    async recoverIdentity(
      phrase: string[],
      password: string,
      confirmReplace?: boolean,
    ): Promise<IdentityRecovery> {
      if (!keystorePath) {
        throw new Error("identity management is not configured on this server");
      }
      assertPassword(password);
      if (!Array.isArray(phrase) || phrase.length !== 12) {
        throw new Error("recovery phrase must have exactly 12 words");
      }
      if (existsSync(keystorePath) && !confirmReplace) {
        throw new Error("keystore already exists; set confirmReplace to true to overwrite");
      }
      let identity: ReturnType<typeof recoverIdentity> extends infer R ? R : never;
      try {
        identity = recoverIdentity(phrase);
      } catch (err) {
        throw new Error(`invalid recovery phrase: ${(err as Error).message}`);
      }
      const publicKey = identity.publicKey.toString("base64");
      try {
        await saveIdentity(identity, password, keystorePath);
      } finally {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
      }
      unlockedPublicKey = publicKey;
      return { publicKey };
    },

    async uploadFile(filename: string, data: Buffer): Promise<UploadFileResult> {
      if (!catalog || !dekStore) {
        throw new Error("manifest store is not configured on this server");
      }
      if (!Buffer.isBuffer(data)) {
        throw new Error("invalid upload: data must be a Buffer");
      }
      if (data.length === 0) {
        throw new Error("file is empty: empty files are rejected");
      }
      if (data.length > MAX_UPLOAD_BYTES) {
        throw new Error("file too large (100 MB limit)");
      }
      const safeFilename = sanitizeUploadFilename(filename);
      // Available nodes only: heartbeat-expired (offline/dead) records
      // are excluded from selection. Snapshots still list them so the
      // UI can show them as offline — selection must never use them.
      const endpoints: StorageNodeEndpoint[] = registry ? registry.getAvailableEndpoints() : [];
      if (endpoints.length === 0) {
        throw new Error("no storage nodes available");
      }
      // The pipeline encrypts every chunk with a fresh per-file DEK and
      // fresh IVs, stores only ciphertext on the nodes, and persists the
      // manifest only after every chunk lands on at least one node.
      const { manifest, encryptionKey } = await uploadBuffer(data, safeFilename, endpoints, {
        manifestStore: catalog.store,
      });
      try {
        try {
          // Vault the DEK so this file stays downloadable. If vaulting
          // fails, roll the manifest back: a catalog entry without its
          // key would be a misleading, unrecoverable record.
          await dekStore.saveDek(manifest.fileId, encryptionKey);
        } catch (dekErr) {
          try {
            await catalog.store.delete(manifest.fileId);
          } catch {}
          throw new Error(`upload failed: could not persist file key (${(dekErr as Error).message})`);
        }
        return {
          fileId: manifest.fileId,
          filename: manifest.filename,
          size: manifest.size,
          totalChunks: manifest.totalChunks,
        };
      } finally {
        // The per-file DEK must never linger in server memory: the
        // caller only ever receives safe metadata above.
        encryptionKey.fill(0);
      }
    },

    async downloadFile(fileId: string): Promise<DownloadFileResult> {
      if (!catalog || !dekStore) {
        throw new Error("manifest store is not configured on this server");
      }
      if (!isValidManifestFileId(fileId)) {
        throw new Error("invalid file id");
      }
      // load() revalidates the manifest (ordering, hashes, no key
      // material); missing manifests resolve to undefined.
      const manifest = await catalog.store.load(fileId);
      if (!manifest) {
        throw new Error("file not found");
      }
      const dek = await dekStore.loadDek(fileId);
      if (!dek) {
        throw new Error("file key unavailable: this file was not uploaded through this server");
      }
      try {
        const endpoints: StorageNodeEndpoint[] = registry ? registry.getAvailableEndpoints() : [];
        if (endpoints.length === 0) {
          throw new Error("no storage nodes available");
        }
        // Replica rotation: the download pipeline fetches each piece from
        // the first healthy replica, but a corrupt-yet-servable replica
        // fails hash verification instead of falling through. Rotating the
        // endpoint order gives every replica a chance to serve all pieces
        // before failing closed.
        let lastError: unknown = null;
        for (let rotation = 0; rotation < endpoints.length; rotation += 1) {
          const ordered = endpoints.slice(rotation).concat(endpoints.slice(0, rotation));
          try {
            const data = await downloadBuffer(manifest, dek, ordered);
            // Belt-and-braces: per-chunk size/hash/order were already
            // verified inside downloadBuffer; confirm the total too.
            if (data.length !== manifest.size) {
              throw new Error("download failed: reconstructed size mismatch");
            }
            return {
              fileId: manifest.fileId,
              filename: manifest.filename,
              size: data.length,
              data,
            };
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError instanceof Error ? lastError : new Error("download failed");
      } finally {
        dek.fill(0);
      }
    },
  };
}
