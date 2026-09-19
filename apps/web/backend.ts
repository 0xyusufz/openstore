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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
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
import { createMarketplace } from "../../packages/marketplace/index.js";
import type { MarketplaceFilter, MarketplaceProvider, MarketplaceSnapshot } from "../../packages/marketplace/index.js";

export type { MarketplaceFilter, MarketplaceProvider, MarketplaceSnapshot } from "../../packages/marketplace/index.js";
import { createDekStore } from "./dekstore.js";
import type { DekStore } from "./dekstore.js";
import type { StorageNodeEndpoint } from "../client/index.js";
import type { Registry } from "../../packages/registry/index.js";
import { MOCK_FILES, MOCK_IDENTITY, MOCK_NODES } from "./src/mock.js";
import { toWebNode } from "./src/types.js";
import type { WebIdentityStatus, WebNode } from "./src/types.js";

export const WEB_BACKEND_VERSION = 1;

/**
 * Account-keyed local storage (per-account isolation).
 * Each account's publicKey (base64) is mapped to a filesystem-safe
 * accountId via hex of the raw SPKI bytes (deterministic, no user input).
 * Layout:
 *   <baseDir>/accounts/<accountId>/identity.keystore
 *   <baseDir>/accounts/<accountId>/manifests/
 *   <baseDir>/accounts/<accountId>/deks.json
 *   <baseDir>/current-account.json  -> {accountId, publicKey}
 * Only the accountId/publicKey are stored in the pointer; no secrets.
 */
function accountIdFromPublicKey(publicKeyBase64: string): string {
  // Safe deterministic accountId: hex of SPKI bytes, prevents traversal and is stable
  const buf = Buffer.from(publicKeyBase64, "base64");
  if (buf.length === 0) throw new Error("invalid public key");
  return buf.toString("hex");
}

function getAccountsDir(manifestDir: string | undefined, keystorePath: string | null): string | null {
  if (manifestDir) return join(dirname(resolve(manifestDir)), "accounts");
  if (keystorePath) return join(dirname(resolve(keystorePath)), "accounts");
  return null;
}

function getCurrentAccountPath(manifestDir: string | undefined, keystorePath: string | null): string | null {
  if (manifestDir) return join(dirname(resolve(manifestDir)), "current-account.json");
  if (keystorePath) return join(dirname(resolve(keystorePath)), "current-account.json");
  return null;
}

function readCurrentAccountIdSync(currentAccountPath: string | null): string | null {
  if (!currentAccountPath || !existsSync(currentAccountPath)) return null;
  try {
    const text = readFileSync(currentAccountPath, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const accountId = parsed["accountId"];
    if (typeof accountId === "string" && /^[0-9a-f]{1,256}$/.test(accountId)) return accountId;
    return null;
  } catch {
    return null;
  }
}

function writeCurrentAccountPointerSync(currentAccountPath: string, accountId: string, publicKey: string): void {
  // Atomic, durable write: temp + rename + 0600, fail-closed
  const tmp = `${currentAccountPath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify({ accountId, publicKey }, null, 2);
  mkdirSync(dirname(currentAccountPath), { recursive: true });
  writeFileSync(tmp, payload, { mode: 0o600 });
  // Ensure 0600 even if file existed
  try { writeFileSync(tmp, payload, { mode: 0o600 }); } catch {}
  renameSync(tmp, currentAccountPath);
  try { writeFileSync(currentAccountPath, payload, { mode: 0o600 }); } catch {}
}

function getAccountPaths(accountsDir: string, accountId: string): { keystorePath: string; manifestDir: string; dekPath: string; accountDir: string } {
  if (!/^[0-9a-f]{1,256}$/.test(accountId)) throw new Error("invalid accountId");
  const accountDir = join(accountsDir, accountId);
  return {
    accountDir,
    keystorePath: join(accountDir, "identity.keystore"),
    manifestDir: join(accountDir, "manifests"),
    dekPath: join(accountDir, "deks.json"),
  };
}

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
  /** Password protecting the provider node identity keystore. */
  providerIdentityPassword?: string;
}

/** Creation result: public metadata plus the phrase shown exactly once. */
export interface IdentityCreation {
  publicKey: string;
  recoveryPhrase: string[];
}

/** Safe account summary for the login/account-selection page. No secrets. */
export interface AccountSummary {
  accountId: string;
  publicKey: string;
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
   * When `accountId` is provided, unlocks that specific local account
   * (switching the current-account pointer on success).
   */
  unlockIdentity(password: string, accountId?: string): Promise<IdentityUnlock>;
  /** Clear the server-side unlocked flag. */
  lockIdentity(): void;
  /** Safe list of local account namespaces. Empty when none exist. */
  listAccounts(): Promise<AccountSummary[]>;
  /** True when protected operations are allowed (no accounts yet, or an account is unlocked). */
  isAuthenticated(): boolean;
  /** True when local account management is configured (keystore/accounts). */
  requiresAuthentication(): boolean;
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
   * Change password for the current account, requiring the OpenStore
   * Recovery Phrase v1. Preserves the same identity, re-encrypts the
   * keystore with the new password, and does not change the public key.
   */
  changePassword(
    phrase: string[],
    newPassword: string,
  ): Promise<IdentityRecovery>;
  /**
   * Switch to another account using its Recovery Phrase v1.
   * Valid phrase restores the corresponding identity; invalid is rejected.
   * Keeps existing manifest/DEK files (isolation limited by single manifestDir).
   */
  switchAccount(
    phrase: string[],
    password: string,
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
  /**
   * Marketplace provider listings — backend-authoritative, capacity/operational only.
   * Excludes draining/released/ineligible providers; fail-closed when coordinator
   * is not configured or listing would require stale data.
   * No economics/credits/payment semantics.
   */
  readonly marketplace: {
    list(filter?: MarketplaceFilter): MarketplaceProvider[];
    snapshot(filter?: MarketplaceFilter): MarketplaceSnapshot;
  };
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
  if (options.providerIdentityPassword !== undefined &&
      (typeof options.providerIdentityPassword !== "string" || options.providerIdentityPassword === "")) {
    throw new TypeError("providerIdentityPassword must be a non-empty string");
  }
  const registry = options.registry ?? null;
  // Account-keyed storage: derive accountsDir and current-account pointer from manifestDir/keystorePath
  const accountsDir = getAccountsDir(options.manifestDir, options.keystorePath ?? null);
  const currentAccountPath = getCurrentAccountPath(options.manifestDir, options.keystorePath ?? null);
  // Resolve current account: if current-account.json exists, use its accountId; else fallback to legacy single-account files
  let currentAccountId = currentAccountPath ? readCurrentAccountIdSync(currentAccountPath) : null;
  let activeKeystorePath: string | null = options.keystorePath ?? null;
  let activeManifestDir: string | null = options.manifestDir ?? null;
  let activeDekPath: string | null = options.dekPath ?? (options.manifestDir ? `${options.manifestDir}.deks.json` : null);
  if (accountsDir && currentAccountId) {
    try {
      const paths = getAccountPaths(accountsDir, currentAccountId);
      // Verify that the account's keystore actually exists and is readable (fail-closed: keep legacy if not)
      if (existsSync(paths.keystorePath)) {
        activeKeystorePath = paths.keystorePath;
        activeManifestDir = paths.manifestDir;
        activeDekPath = paths.dekPath;
      }
    } catch {}
  }
  let catalog = activeManifestDir ? createFileCatalog(createManifestStore({ dir: activeManifestDir })) : null;
  let keystorePath: string | null = activeKeystorePath;
  // Provider config lives next to the manifests (sibling file, invisible
  // to the catalog) and shares this backend's registry, so the UI's Live
  // mode and upload/download selection all see the same real nodes.
  const provider = createProviderManager({
    configPath: options.manifestDir ? `${options.manifestDir}.provider.json` : null,
    registry,
    identityPassword: options.providerIdentityPassword ?? process.env["OPENSTORE_PROVIDER_IDENTITY_PASSWORD"],
  });
  // Marketplace is backend-authoritative: derived only from the live registry.
  // No stale or demo synthesis; unconfigured registry fails closed.
  const marketplace = registry
    ? createMarketplace(registry)
    : {
        version: 1,
        list: (): never => { throw new Error("marketplace unavailable: coordinator not configured"); },
        snapshot: (): never => { throw new Error("marketplace unavailable: coordinator not configured"); },
        isEligible: (): never => { throw new Error("marketplace unavailable: coordinator not configured"); },
      } as unknown as ReturnType<typeof createMarketplace>;
  // The DEK vault lives alongside the manifests (sibling file, never
  // inside the manifest directory) and only exists for live backends.
  // Per-account: use activeDekPath when available, else legacy.
  let dekStore: DekStore | null = activeDekPath ? createDekStore({ path: activeDekPath }) : null;
  const status: BackendStatus = {
    demoMode: !catalog && !registry,
    manifestStore: catalog !== null,
    registry: registry !== null,
  };

  // Server-side unlock flag: public metadata only (base64 public key).
  // Private key material is never cached — unlock verifies, wipes, drops.
  let unlockedPublicKey: string | null = null;

  // Resolve active keystore path dynamically from current-account.json (per-account) with legacy fallback
  function resolveActiveKeystorePathSync(): string | null {
    if (accountsDir && currentAccountPath) {
      const currentId = readCurrentAccountIdSync(currentAccountPath);
      if (currentId) {
        try {
          const paths = getAccountPaths(accountsDir, currentId);
          if (existsSync(paths.keystorePath)) return paths.keystorePath;
        } catch {}
      }
    }
    return activeKeystorePath;
  }

  // Atomically switch active account context after verifying target keystore
  function activateAccountSync(accountId: string, publicKey: string): void {
    if (!accountsDir || !currentAccountPath) throw new Error("account management not configured");
    const paths = getAccountPaths(accountsDir, accountId);
    if (!existsSync(paths.keystorePath)) throw new Error("account keystore not found");
    // Verify keystore publicKey matches expected (fail-closed, no partial switch)
    const text = readFileSync(paths.keystorePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("account keystore is malformed");
    }
    const storedPubKey = (parsed as Record<string, unknown>)["publicKey"];
    if (storedPubKey !== publicKey) throw new Error("account public key mismatch");
    mkdirSync(paths.manifestDir, { recursive: true });
    // Only after verification, atomically update pointer
    writeCurrentAccountPointerSync(currentAccountPath, accountId, publicKey);
    // Reload active context — avoid stale references
    keystorePath = paths.keystorePath;
    activeManifestDir = paths.manifestDir;
    activeDekPath = paths.dekPath;
    catalog = createFileCatalog(createManifestStore({ dir: activeManifestDir }));
    dekStore = createDekStore({ path: activeDekPath });
    currentAccountId = accountId;
    unlockedPublicKey = publicKey;
  }

  function getActiveCatalog(): ReturnType<typeof createFileCatalog> | null {
    if (accountsDir && currentAccountPath) {
      const currentId = readCurrentAccountIdSync(currentAccountPath);
      if (currentId) {
        try {
          const paths = getAccountPaths(accountsDir, currentId);
          return createFileCatalog(createManifestStore({ dir: paths.manifestDir }));
        } catch {}
      }
    }
    return catalog;
  }

  function getActiveDekStore(): DekStore | null {
    if (accountsDir && currentAccountPath) {
      const currentId = readCurrentAccountIdSync(currentAccountPath);
      if (currentId) {
        try {
          const paths = getAccountPaths(accountsDir, currentId);
          return createDekStore({ path: paths.dekPath });
        } catch {}
      }
    }
    return dekStore;
  }

  /** True when at least one local account namespace/keystore exists. */
  function hasAnyLocalAccountSync(): boolean {
    if (accountsDir) {
      try {
        const entries = readdirSync(accountsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^[0-9a-f]{1,256}$/.test(entry.name)) continue;
          try {
            if (existsSync(join(accountsDir, entry.name, "identity.keystore"))) return true;
          } catch {}
        }
      } catch {}
      if (currentAccountPath && readCurrentAccountIdSync(currentAccountPath)) return true;
    }
    if (options.keystorePath && existsSync(options.keystorePath)) return true;
    if (keystorePath && existsSync(keystorePath)) return true;
    return false;
  }

  /** Safe list of local accounts (public metadata only). */
  function listLocalAccountsSync(): AccountSummary[] {
    const out = new Map<string, AccountSummary>();
    if (accountsDir) {
      let entries: import("fs").Dirent[] | undefined;
      try {
        entries = readdirSync(accountsDir, { withFileTypes: true });
      } catch {
        entries = undefined;
      }
      if (entries) {
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^[0-9a-f]{1,256}$/.test(entry.name)) continue;
          const ksPath = join(accountsDir, entry.name, "identity.keystore");
          try {
            if (!existsSync(ksPath)) continue;
            const text = readFileSync(ksPath, "utf8");
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const pubkey = parsed["publicKey"];
            if (typeof pubkey !== "string" || pubkey === "") continue;
            const accountId = entry.name;
            if (!out.has(accountId)) out.set(accountId, { accountId, publicKey: pubkey });
          } catch {}
        }
      }
    }
    // Legacy single-file keystore fallback (same accountId namespace when applicable)
    for (const legacyPath of [options.keystorePath ?? null, keystorePath]) {
      if (!legacyPath || out.size > 0) continue;
      try {
        if (!existsSync(legacyPath)) continue;
        const text = readFileSync(legacyPath, "utf8");
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const pubkey = parsed["publicKey"];
        if (typeof pubkey !== "string" || pubkey === "") continue;
        const accountId = accountIdFromPublicKey(pubkey);
        if (!out.has(accountId)) out.set(accountId, { accountId, publicKey: pubkey });
      } catch {}
    }
    return [...out.values()].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }

  function assertPassword(password: unknown): asserts password is string {
    if (typeof password !== "string" || password === "") {
      throw new Error("a non-empty password is required");
    }
  }

  /** Public key from the keystore file, or null when absent/unreadable. */
  async function readKeystorePublicKey(): Promise<string | null> {
    const activePath = resolveActiveKeystorePathSync() ?? keystorePath;
    if (!activePath) return null;
    let text: string;
    try {
      text = await readFile(activePath, "utf8");
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
    const activePath = resolveActiveKeystorePathSync() ?? keystorePath;
    if (!activePath) {
      if (options.identityLabel) {
        return { configured: true, unlocked: false, label: options.identityLabel };
      }
      return { ...MOCK_IDENTITY };
    }
    const pubkey = await readKeystorePublicKey();
    if (!pubkey) {
      const exists = activePath ? existsSync(activePath) : false;
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
    marketplace,

    async getSnapshot(): Promise<BackendSnapshot> {
      const activeCatalogSnap = getActiveCatalog();
      const files = activeCatalogSnap ? await activeCatalogSnap.listEntries() : MOCK_FILES.map((f) => ({ ...f }));
      const nodes = registry ? registry.list().map(toWebNode) : MOCK_NODES.map((n) => ({ ...n }));
      const identity: WebIdentityStatus = (resolveActiveKeystorePathSync() ?? keystorePath)
        ? await identityStatus()
        : options.identityLabel
          ? { configured: true, unlocked: false, label: options.identityLabel }
          : activeCatalogSnap || registry
            ? { configured: false, unlocked: false, label: "no local identity linked" }
            : { ...MOCK_IDENTITY };
      return {
        files,
        nodes,
        identity,
        filesSource: activeCatalogSnap ? "live" : "demo",
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
      assertPassword(password);
      // Per-account mode: create a new isolated account namespace
      if (accountsDir && currentAccountPath) {
        const currentIdFromDisk = readCurrentAccountIdSync(currentAccountPath);
        if (currentIdFromDisk !== null) {
          throw new Error("identity already configured");
        }
        // Also fail if legacy single-file keystore exists and is malformed/broken (to preserve 409 behavior for broken file)
        if (options.keystorePath && existsSync(options.keystorePath)) {
          throw new Error("identity already configured");
        }
        const identity = createIdentity();
        const publicKey = identity.publicKey.toString("base64");
        const recoveryPhrase = [...identity.recoveryPhrase];
        const accountId = accountIdFromPublicKey(publicKey);
        const paths = getAccountPaths(accountsDir, accountId);
        if (existsSync(paths.keystorePath) || existsSync(paths.accountDir)) {
          identity.privateKey.fill(0);
          identity.recoveryPhrase.fill("");
          throw new Error("account already exists");
        }
        // Create namespace atomically: ensure dirs, save keystore, then make current only after success
        try {
          mkdirSync(paths.accountDir, { recursive: true });
          mkdirSync(paths.manifestDir, { recursive: true });
          await saveIdentity(identity, password, paths.keystorePath);
          // Verify keystore readable before switching current pointer (fail-closed)
          const verifyText = readFileSync(paths.keystorePath, "utf8");
          JSON.parse(verifyText);
          writeCurrentAccountPointerSync(currentAccountPath, accountId, publicKey);
          // Reload active context
          keystorePath = paths.keystorePath;
          activeManifestDir = paths.manifestDir;
          activeDekPath = paths.dekPath;
          catalog = createFileCatalog(createManifestStore({ dir: activeManifestDir }));
          dekStore = createDekStore({ path: activeDekPath });
          currentAccountId = accountId;
          unlockedPublicKey = publicKey;
          // For backward compatibility with single-file tests, also mirror to legacy keystorePath
          if (options.keystorePath && options.keystorePath !== paths.keystorePath) {
            try {
              const content = readFileSync(paths.keystorePath, "utf8");
              mkdirSync(dirname(options.keystorePath), { recursive: true });
              writeFileSync(options.keystorePath, content, { mode: 0o600 });
            } catch {}
          }
        } finally {
          identity.privateKey.fill(0);
          identity.recoveryPhrase.fill("");
        }
        return { publicKey, recoveryPhrase };
      }
      // Legacy single-account mode
      if (!keystorePath) {
        throw new Error("identity management is not configured on this server");
      }
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

    async unlockIdentity(password: string, accountId?: string): Promise<IdentityUnlock> {
      assertPassword(password);
      // Unlock a specific local account (login page account card).
      if (accountId !== undefined) {
        if (typeof accountId !== "string" || !/^[0-9a-f]{1,256}$/.test(accountId)) {
          throw new Error("invalid account");
        }
        if (!accountsDir || !currentAccountPath) {
          throw new Error("identity management is not configured on this server");
        }
        const paths = getAccountPaths(accountsDir, accountId);
        const identity = await loadIdentity(password, paths.keystorePath);
        try {
          const publicKey = identity.publicKey.toString("base64");
          const derivedId = accountIdFromPublicKey(publicKey);
          if (derivedId !== accountId) throw new Error("account public key mismatch");
          activateAccountSync(accountId, publicKey);
          return { unlocked: true, publicKey };
        } finally {
          identity.privateKey.fill(0);
          identity.recoveryPhrase.fill("");
        }
      }
      const activePath = resolveActiveKeystorePathSync() ?? keystorePath;
      if (!activePath) {
        throw new Error("identity management is not configured on this server");
      }
      const identity = await loadIdentity(password, activePath);
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

    async listAccounts(): Promise<AccountSummary[]> {
      return listLocalAccountsSync();
    },

    isAuthenticated(): boolean {
      // No local accounts yet (first-run) → public flows allowed.
      if (!hasAnyLocalAccountSync()) return true;
      return unlockedPublicKey !== null;
    },

    requiresAuthentication(): boolean {
      return hasAnyLocalAccountSync();
    },

    async recoverIdentity(
      phrase: string[],
      password: string,
      confirmReplace?: boolean,
    ): Promise<IdentityRecovery> {
      assertPassword(password);
      if (!Array.isArray(phrase) || phrase.length !== 12) {
        throw new Error("recovery phrase must have exactly 12 words");
      }
      // Per-account mode: create/overwrite that account's namespace, make it current
      if (accountsDir && currentAccountPath) {
        let identity: ReturnType<typeof recoverIdentity> extends infer R ? R : never;
        try {
          identity = recoverIdentity(phrase);
        } catch (err) {
          throw new Error(`invalid recovery phrase: ${(err as Error).message}`);
        }
        const publicKey = identity.publicKey.toString("base64");
        const accountId = accountIdFromPublicKey(publicKey);
        const paths = getAccountPaths(accountsDir, accountId);
        // For per-account, check if *any* current account exists and confirmReplace is required to overwrite current
        // If currentAccountId exists and is different from target, switching to a new account without confirmReplace
        // should still be considered overwriting the current selection, but for recovery we require explicit confirmReplace
        // when a current account is already configured (to match legacy 409 behavior)
        const currentIdFromDisk = readCurrentAccountIdSync(currentAccountPath);
        const hasCurrent = currentIdFromDisk !== null;
        const targetExists = existsSync(paths.keystorePath);
        if ((hasCurrent || targetExists) && !confirmReplace) {
          identity.privateKey.fill(0);
          identity.recoveryPhrase.fill("");
          throw new Error("keystore already exists; set confirmReplace to true to overwrite");
        }
        try {
          mkdirSync(paths.accountDir, { recursive: true });
          mkdirSync(paths.manifestDir, { recursive: true });
          await saveIdentity(identity, password, paths.keystorePath);
          // Verify before switching current pointer (fail-closed)
          const verifyText = readFileSync(paths.keystorePath, "utf8");
          JSON.parse(verifyText);
          writeCurrentAccountPointerSync(currentAccountPath, accountId, publicKey);
          // Reload active context
          keystorePath = paths.keystorePath;
          activeManifestDir = paths.manifestDir;
          activeDekPath = paths.dekPath;
          catalog = createFileCatalog(createManifestStore({ dir: activeManifestDir }));
          dekStore = createDekStore({ path: activeDekPath });
          currentAccountId = accountId;
          unlockedPublicKey = publicKey;
          // For backward compatibility with single-file tests, also mirror to legacy keystorePath
          if (options.keystorePath && options.keystorePath !== paths.keystorePath) {
            try {
              const content = readFileSync(paths.keystorePath, "utf8");
              mkdirSync(dirname(options.keystorePath), { recursive: true });
              writeFileSync(options.keystorePath, content, { mode: 0o600 });
            } catch {}
          }
        } finally {
          identity.privateKey.fill(0);
          identity.recoveryPhrase.fill("");
        }
        return { publicKey };
      }
      // Legacy single-file mode
      if (!keystorePath) {
        throw new Error("identity management is not configured on this server");
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

    /**
     * Change password for the current account, requiring proof of the
     * OpenStore Recovery Phrase v1. Preserves the same Ed25519 identity
     * (same publicKey/account ID), re-encrypts the keystore with the new
     * password, and does not generate a new identity. Fails closed if the
     * phrase is invalid or does not match the current account.
     */
    async changePassword(
      phrase: string[],
      newPassword: string,
    ): Promise<IdentityRecovery> {
      const activePathForChange = resolveActiveKeystorePathSync() ?? keystorePath;
      if (!activePathForChange) {
        throw new Error("identity management is not configured on this server");
      }
      assertPassword(newPassword);
      if (!Array.isArray(phrase) || phrase.length !== 12) {
        throw new Error("recovery phrase must have exactly 12 words");
      }
      const currentPubKey = await readKeystorePublicKey();
      if (!currentPubKey) {
        throw new Error("no account is configured");
      }
      let identity: ReturnType<typeof recoverIdentity> extends infer R ? R : never;
      try {
        identity = recoverIdentity(phrase);
      } catch (err) {
        throw new Error(`invalid recovery phrase: ${(err as Error).message}`);
      }
      const derivedPubKey = identity.publicKey.toString("base64");
      if (derivedPubKey !== currentPubKey) {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
        throw new Error("recovery phrase does not match current account");
      }
      try {
        await saveIdentity(identity, newPassword, activePathForChange);
        if (options.keystorePath && options.keystorePath !== activePathForChange) {
          try {
            const content = readFileSync(activePathForChange, "utf8");
            mkdirSync(dirname(options.keystorePath), { recursive: true });
            writeFileSync(options.keystorePath, content, { mode: 0o600 });
          } catch {}
        }
      } finally {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
      }
      unlockedPublicKey = derivedPubKey;
      return { publicKey: derivedPubKey };
    },

    /**
     * Switch to another account using its Recovery Phrase v1.
     * Valid phrase restores the corresponding identity; invalid is rejected.
     * Per-account: creates/uses that account's isolated namespace and
     * atomically switches current-account pointer; previous account's
     * manifests/DEKs remain untouched and are reloaded when switching back.
     */
    async switchAccount(
      phrase: string[],
      password: string,
    ): Promise<IdentityRecovery> {
      assertPassword(password);
      if (!Array.isArray(phrase) || phrase.length !== 12) {
        throw new Error("recovery phrase must have exactly 12 words");
      }
      let identity: ReturnType<typeof recoverIdentity> extends infer R ? R : never;
      try {
        identity = recoverIdentity(phrase);
      } catch (err) {
        throw new Error(`invalid recovery phrase: ${(err as Error).message}`);
      }
      const publicKey = identity.publicKey.toString("base64");
      const accountId = accountIdFromPublicKey(publicKey);
      if (accountsDir && currentAccountPath) {
        const paths = getAccountPaths(accountsDir, accountId);
        try {
          mkdirSync(paths.accountDir, { recursive: true });
          mkdirSync(paths.manifestDir, { recursive: true });
          await saveIdentity(identity, password, paths.keystorePath);
          const verifyText = readFileSync(paths.keystorePath, "utf8");
          JSON.parse(verifyText);
          writeCurrentAccountPointerSync(currentAccountPath, accountId, publicKey);
          keystorePath = paths.keystorePath;
          activeManifestDir = paths.manifestDir;
          activeDekPath = paths.dekPath;
          catalog = createFileCatalog(createManifestStore({ dir: activeManifestDir }));
          dekStore = createDekStore({ path: activeDekPath });
          currentAccountId = accountId;
          unlockedPublicKey = publicKey;
          if (options.keystorePath && options.keystorePath !== paths.keystorePath) {
            try {
              const content = readFileSync(paths.keystorePath, "utf8");
              mkdirSync(dirname(options.keystorePath), { recursive: true });
              writeFileSync(options.keystorePath, content, { mode: 0o600 });
            } catch {}
          }
        } finally {
          identity.privateKey.fill(0);
          identity.recoveryPhrase.fill("");
        }
        return { publicKey };
      }
      if (!keystorePath) {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
        throw new Error("identity management is not configured on this server");
      }
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
      const activeCatalogForUpload = getActiveCatalog();
      const activeDekStoreForUpload = getActiveDekStore();
      if (!activeCatalogForUpload || !activeDekStoreForUpload) {
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
        manifestStore: activeCatalogForUpload.store,
      });
      try {
        try {
          // Vault the DEK so this file stays downloadable. If vaulting
          // fails, roll the manifest back: a catalog entry without its
          // key would be a misleading, unrecoverable record.
          await activeDekStoreForUpload.saveDek(manifest.fileId, encryptionKey);
        } catch (dekErr) {
          try {
            await activeCatalogForUpload.store.delete(manifest.fileId);
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
      const activeCatalogForDownload = getActiveCatalog();
      const activeDekStoreForDownload = getActiveDekStore();
      if (!activeCatalogForDownload || !activeDekStoreForDownload) {
        throw new Error("manifest store is not configured on this server");
      }
      if (!isValidManifestFileId(fileId)) {
        throw new Error("invalid file id");
      }
      // load() revalidates the manifest (ordering, hashes, no key
      // material); missing manifests resolve to undefined.
      const manifest = await activeCatalogForDownload.store.load(fileId);
      if (!manifest) {
        throw new Error("file not found");
      }
      const dek = await activeDekStoreForDownload.loadDek(fileId);
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
