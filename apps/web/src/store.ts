/**
 * OpenStore Web Frontend — UI state (OPENSTORE-023).
 *
 * Pure, framework-free state transitions over mock/in-memory data.
 * Honesty rules enforced here, not just in the views:
 * - Uploads are never recorded as performed (no backend yet).
 * - Deletes never remove files (no backend yet).
 * - These operations surface an explicit notice instead of fake success.
 */

import { DEMO_MODE, MOCK_FILES, MOCK_IDENTITY, MOCK_NODES } from "./mock.js";
import type { DashboardStats, WebIdentityStatus, WebNode } from "./types.js";
import type { CatalogEntry } from "../../client/catalog.js";
import type { BackendSnapshot, IdentityCreation, ProviderStatus, UploadFileResult } from "../backend.js";

export type ViewId = "dashboard" | "files" | "upload" | "nodes" | "settings";

export const VIEWS: { id: ViewId; label: string; hash: string }[] = [
  { id: "dashboard", label: "Dashboard", hash: "#/dashboard" },
  { id: "files", label: "My Files", hash: "#/files" },
  { id: "upload", label: "Upload", hash: "#/upload" },
  { id: "nodes", label: "Storage Nodes", hash: "#/nodes" },
  { id: "settings", label: "Settings", hash: "#/settings" },
];

export type UploadStatus = "idle" | "ready" | "preparing" | "encrypting" | "storing" | "complete" | "failed";

export interface UploadDraft {
  status: UploadStatus;
  fileName: string;
  fileSize: number;
  note: string | null;
  /** Whether the last failure is retryable (transient). */
  retryable: boolean;
}

export type DownloadStatus = "idle" | "locating" | "downloading" | "decrypting" | "verifying" | "active" | "complete" | "failed";

export interface DownloadDraft {
  status: DownloadStatus;
  fileId: string | null;
  filename: string;
  note: string | null;
  retryable: boolean;
}

export interface WebState {
  view: ViewId;
  files: CatalogEntry[];
  nodes: WebNode[];
  identity: WebIdentityStatus;
  /**
   * Transient creation result holding the recovery phrase for one-time
   * backup display. Never persisted, never sent anywhere; cleared on
   * dismiss. No other private material ever enters UI state.
   */
  identityCreation: IdentityCreation | null;
  /** Whether the recovery phrase in the creation backup is revealed. */
  recoveryPhraseRevealed: boolean;
  upload: UploadDraft;
  /**
   * Transient download progress. File bytes never enter UI state — the
   * browser receives them as a Blob handed straight to an object URL.
   */
  download: DownloadDraft;
  /**
   * Storage provider status (Share Storage). Null when unconfigured or
   * in demo mode. Never carries secrets — public metadata only.
   */
  provider: ProviderStatus | null;
  notice: string | null;
  demoMode: boolean;
}

export function createInitialState(): WebState {
  return {
    view: "dashboard",
    files: MOCK_FILES.map((f) => ({ ...f })),
    nodes: MOCK_NODES.map((n) => ({ ...n })),
    identity: { ...MOCK_IDENTITY },
    identityCreation: null,
    recoveryPhraseRevealed: false,
    upload: { status: "idle", fileName: "", fileSize: 0, note: null, retryable: false },
    download: { status: "idle", fileId: null, filename: "", note: null, retryable: false },
    provider: null,
    notice: null,
    demoMode: DEMO_MODE,
  };
}

/** Map a location hash to a view (unknown → dashboard). */
export function parseHash(hash: string): ViewId {
  const found = VIEWS.find((v) => v.hash === hash);
  return found ? found.id : "dashboard";
}

export function navigate(state: WebState, view: ViewId): WebState {
  return { ...state, view, notice: null };
}

/**
 * Map raw/technical errors to short, actionable messages.
 *
 * Safe actionable messages (no storage nodes, key unavailable, file
 * not found, node unreachable, quota, draining, timeouts, corruption
 * verdicts, piece IDs, node IDs) are preserved verbatim or mapped to
 * plain language. Anything carrying secrets (keys, phrases, passwords,
 * plaintext), filesystem paths, or stack traces falls back to generic.
 */
export function toUserFacingError(message: string): string {
  const raw = (message || "").trim();
  if (!raw) return "Something went wrong. Please try again.";
  if (/privatekey|recoveryphrase|mnemonic|encryptionkey|decryptionkey|\bdek\b|password|plaintext|auth\s*tag|authtag|ciphertext/i.test(raw)) {
    return "Something went wrong. Please try again.";
  }
  if (/\/[^\s]*\.(?:json|txt|log|db)|ENOENT|EACCES|statfs|\bat .*:\d+:\d+|\bstack\b/i.test(raw)) {
    return "Storage error. Please try again.";
  }
  if (/file is empty/i.test(raw)) return "File is empty and cannot be uploaded.";
  if (/file too large/i.test(raw)) return "File is too large (100 MB limit).";
  if (/invalid filename/i.test(raw)) return "Filename is not valid.";
  if (/no storage nodes available/i.test(raw)) return "No storage nodes are available. Try again when a node is online.";
  if (/insufficient storage|quota/i.test(raw)) return "Storage is full. Free up space or increase your allocation.";
  if (/draining/i.test(raw)) return "A storage node is draining and not accepting new data. Try again shortly.";
  if (/network|timeout|econn|aborted|interrupted/i.test(raw)) return "Network error. Check your connection and try again.";
  if (/corrupt|hash mismatch|size mismatch|decryption failed|wrong key/i.test(raw)) return "File appears corrupted or the key is wrong. Download failed safely.";
  if (/piece.*unavailable/i.test(raw)) return "File pieces are temporarily unavailable. Try again shortly.";
  if (/manifest|invalid file id|not found|key unavailable/i.test(raw)) return "File not found or is unavailable.";
  if (/[^0-9]500|[^0-9]502|[^0-9]503|[^0-9]504|^50[0234]/i.test(raw)) return "Storage is temporarily unavailable. Please retry.";
  // Otherwise the message passed the secret/path/stack filters above,
  // so preserve it (bounded) — it carries the actionable detail.
  const safe = raw.replace(/\s+/g, " ").trim();
  return safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
}

/** Whether an error message looks retryable (transient). */
export function isRetryableError(message: string): boolean {
  const lower = (message || "").toLowerCase();
  if (/invalid file id|invalid filename|file is empty|file too large|not configured|no storage nodes available|insufficient storage|quota|draining|corrupt|hash mismatch|size mismatch|decryption failed|manifest|wrong key/i.test(lower)) {
    if (/insufficient storage|quota|draining|invalid|file is empty|file too large|wrong key|hash mismatch|size mismatch|decryption failed/i.test(lower)) return false;
    if (/no storage nodes available/i.test(lower)) return true; // transient: node may come back
  }
  return /timeout|network|econn|econrefused|eai_again|fetch failed|temporar|retry|503|502|504|500|aborted|interrupted|unreachable|temporarily unavailable/i.test(lower);
}

/** Whether any transfer is currently active (upload or download). */
export function isTransferActive(state: WebState): boolean {
  return (
    state.upload.status === "preparing" ||
    state.upload.status === "encrypting" ||
    state.upload.status === "storing" ||
    state.download.status === "locating" ||
    state.download.status === "downloading" ||
    state.download.status === "decrypting" ||
    state.download.status === "verifying" ||
    state.download.status === "active"
  );
}

/** Stage a picked file for upload. File bytes are never read or stored. */
export function selectFileForUpload(state: WebState, fileName: string, fileSize: number): WebState {
  if (isTransferActive(state)) {
    return { ...state, notice: "Another transfer is already in progress. Wait for it to finish." };
  }
  if (typeof fileName !== "string" || fileName === "") {
    return { ...state, notice: "Select a valid file first." };
  }
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    return { ...state, notice: "Select a valid file first." };
  }
  return {
    ...state,
    notice: null,
    upload: {
      status: "ready",
      fileName,
      fileSize,
      note: null,
      retryable: false,
    },
  };
}

/**
 * Transition to the preparing stage. The actual upload happens in app.ts
 * after this pure state transition. Preparing is where we validate the
 * filename, check quota, and get ready to encrypt — shown truthfully
 * without fake percentages.
 */
export function attemptUpload(state: WebState): WebState {
  if (isTransferActive(state)) {
    return state;
  }
  if (state.upload.status === "idle") {
    return { ...state, notice: "Select a file first." };
  }
  if (state.upload.status !== "ready") {
    return state;
  }
  return {
    ...state,
    upload: { ...state.upload, status: "preparing", note: "Preparing upload…", retryable: false },
    notice: null,
  };
}

/** Transition from preparing to encrypting (chunking + per-file DEK + AES-GCM). */
export function uploadPreparing(state: WebState): WebState {
  if (state.upload.status !== "preparing") return state;
  return {
    ...state,
    upload: { ...state.upload, status: "encrypting", note: "Encrypting and chunking file..." },
  };
}

/** Transition to storing (replication in progress). */
export function uploadEncrypting(state: WebState): WebState {
  if (state.upload.status !== "encrypting" && state.upload.status !== "preparing") return state;
  // Allow encrypting to be entered directly from preparing (new flow) or
  // from encrypting itself (legacy call). Normalize to storing.
  if (state.upload.status === "preparing") {
    return {
      ...state,
      upload: { ...state.upload, status: "encrypting", note: "Encrypting and chunking file..." },
    };
  }
  return {
    ...state,
    upload: { ...state.upload, status: "storing", note: "Storing encrypted replicas on nodes..." },
  };
}

/** Transition to storing (replication in progress). */
export function uploadStoring(state: WebState): WebState {
  if (state.upload.status !== "storing") return state;
  return state;
}

/** Transition to complete after successful upload. */
export function uploadComplete(
  state: WebState,
  result: UploadFileResult,
): WebState {
  return {
    ...state,
    upload: {
      status: "complete",
      fileName: result.filename,
      fileSize: result.size,
      note: `Uploaded ${result.filename} (${result.totalChunks} chunk(s)).`,
      retryable: false,
    },
    notice: null,
  };
}

/** Transition to failed after upload error. */
export function uploadFailed(state: WebState, error: string): WebState {
  const safe = toUserFacingError(error);
  return {
    ...state,
    upload: { ...state.upload, status: "failed", note: `Upload failed: ${safe}`, retryable: isRetryableError(error) },
    notice: null,
  };
}

/** Whether this upload failure can be retried. */
export function canRetryUpload(state: WebState): boolean {
  return state.upload.status === "failed" && state.upload.retryable;
}

/** Whether a download is currently in flight (any active stage). */
export function isDownloadActive(state: WebState): boolean {
  return (
    state.download.status === "locating" ||
    state.download.status === "downloading" ||
    state.download.status === "decrypting" ||
    state.download.status === "verifying" ||
    state.download.status === "active"
  );
}

/** Whether an upload is currently in flight (any active stage). */
export function isUploadActive(state: WebState): boolean {
  return (
    state.upload.status === "preparing" ||
    state.upload.status === "encrypting" ||
    state.upload.status === "storing"
  );
}

/** Reset a failed upload back to ready so the user can retry the same file. */
export function retryUpload(state: WebState): WebState {
  if (state.upload.status !== "failed" || !state.upload.retryable) return state;
  if (isDownloadActive(state)) return state;
  return {
    ...state,
    upload: { ...state.upload, status: "ready", note: null, retryable: false },
    notice: null,
  };
}

/**
 * Start a download. Only one download runs at a time: while one is
 * active every further attempt is a no-op returning the same state
 * (duplicate-click prevention). The actual fetch happens in app.ts
 * after this pure state transition.
 */
export function attemptDownload(state: WebState, fileId: string): WebState {
  if (isTransferActive(state)) {
    return state;
  }
  if (
    state.download.status === "active" ||
    state.download.status === "locating" ||
    state.download.status === "downloading" ||
    state.download.status === "decrypting" ||
    state.download.status === "verifying"
  ) {
    return state;
  }
  const file = state.files.find((f) => f.fileId === fileId);
  if (!file) {
    return { ...state, notice: `No file with ID "${fileId}".` };
  }
  return {
    ...state,
    notice: null,
    download: {
      status: "locating",
      fileId,
      filename: file.filename,
      note: "Locating file…",
      retryable: false,
    },
  };
}

/** Transition locating → downloading (found manifest, fetching pieces). */
export function downloadLocating(state: WebState): WebState {
  if (state.download.status !== "locating" && state.download.status !== "active") return state;
  return {
    ...state,
    download: { ...state.download, status: "downloading", note: `Downloading "${state.download.filename}"…` },
  };
}

/** Transition downloading → decrypting. */
export function downloadDownloading(state: WebState): WebState {
  if (state.download.status !== "downloading") return state;
  return {
    ...state,
    download: { ...state.download, status: "decrypting", note: "Decrypting…" },
  };
}

/** Transition decrypting → verifying. */
export function downloadDecrypting(state: WebState): WebState {
  if (state.download.status !== "decrypting") return state;
  return {
    ...state,
    download: { ...state.download, status: "verifying", note: "Verifying…" },
  };
}

/** Record a completed download (bytes already handed to the browser). */
export function downloadComplete(
  state: WebState,
  result: { fileId: string; filename: string; size: number },
): WebState {
  return {
    ...state,
    download: {
      status: "complete",
      fileId: result.fileId,
      filename: result.filename,
      note: `Downloaded "${result.filename}" (${result.size} bytes).`,
      retryable: false,
    },
    notice: null,
  };
}

/** Record a failed download with a safe user-facing reason. */
export function downloadFailed(state: WebState, error: string): WebState {
  const safe = toUserFacingError(error);
  return {
    ...state,
    download: {
      ...state.download,
      status: "failed",
      note: `Download failed: ${safe}`,
      retryable: isRetryableError(error),
    },
    notice: null,
  };
}

/** Whether this download failure can be retried. */
export function canRetryDownload(state: WebState): boolean {
  return state.download.status === "failed" && state.download.retryable;
}

/** Reset a failed download back to locating so the user can retry the same file. */
export function retryDownload(state: WebState): WebState {
  if (state.download.status !== "failed" || !state.download.retryable) return state;
  if (isUploadActive(state)) return state;
  const fileId = state.download.fileId;
  if (!fileId) return state;
  const file = state.files.find((f) => f.fileId === fileId);
  if (!file) {
    return { ...state, notice: `No file with ID "${fileId}".` };
  }
  return {
    ...state,
    download: {
      status: "locating",
      fileId,
      filename: file.filename,
      note: "Locating file…",
      retryable: false,
    },
    notice: null,
  };
}

/**
 * Attempt a delete. Always honest: the file entry is kept.
 */
export function attemptDelete(state: WebState, fileId: string): WebState {
  const file = state.files.find((f) => f.fileId === fileId);
  if (!file) {
    return { ...state, notice: `No file with ID "${fileId}".` };
  }
  return {
    ...state,
    notice: `Delete not performed — backend integration is pending. "${file.filename}" was not deleted.`,
  };
}

export function dismissNotice(state: WebState): WebState {
  return { ...state, notice: null };
}

/**
 * Record a completed first-run creation. The phrase stays in memory
 * only until {@link identityCreationDismissed} clears it.
 */
export function identityCreationReceived(
  state: WebState,
  creation: { publicKey: string; recoveryPhrase: string[] },
): WebState {
  if (!creation || typeof creation.publicKey !== "string" || !Array.isArray(creation.recoveryPhrase)) {
    throw new TypeError("creation must carry a publicKey and recoveryPhrase");
  }
  return {
    ...state,
    identity: { configured: true, unlocked: true, label: "local keystore", publicKey: creation.publicKey },
    identityCreation: { publicKey: creation.publicKey, recoveryPhrase: [...creation.recoveryPhrase] },
    notice: null,
  };
}

/** Drop the displayed recovery phrase (backup confirmed by the user). */
export function identityCreationDismissed(state: WebState): WebState {
  return { ...state, identityCreation: null, recoveryPhraseRevealed: false };
}

/** Toggle visibility of the recovery phrase in the creation backup display. */
export function toggleRecoveryPhraseReveal(state: WebState): WebState {
  return { ...state, recoveryPhraseRevealed: !state.recoveryPhraseRevealed };
}

/** Reflect a successful keystore unlock (public metadata only). */
export function identityUnlocked(state: WebState, publicKey: string): WebState {
  if (typeof publicKey !== "string" || publicKey === "") {
    throw new TypeError("publicKey must be a non-empty string");
  }
  return {
    ...state,
    identity: { ...state.identity, configured: true, unlocked: true, label: "local keystore", publicKey },
    notice: null,
  };
}

/** Reflect a lock (server-side flag cleared). */
export function identityLocked(state: WebState): WebState {
  return {
    ...state,
    identity: { ...state.identity, unlocked: false },
    notice: null,
  };
}

/** Reflect a successful identity recovery (public metadata only). */
export function identityRecovered(state: WebState, publicKey: string): WebState {
  if (typeof publicKey !== "string" || publicKey === "") {
    throw new TypeError("publicKey must be a non-empty string");
  }
  return {
    ...state,
    identity: { configured: true, unlocked: true, label: "local keystore", publicKey },
    notice: null,
  };
}

/**
 * Apply a backend snapshot (live or demo) to UI state.
 * Replaces files/nodes/identity wholesale and derives demoMode from
 * the reported sources. Pure and testable; fetching lives in app.ts.
 */
export function applyBackendSnapshot(state: WebState, snapshot: BackendSnapshot): WebState {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("snapshot must be an object");
  }
  if (!Array.isArray(snapshot.files) || !Array.isArray(snapshot.nodes)) {
    throw new TypeError("snapshot must contain files and nodes arrays");
  }
  if (!snapshot.identity || typeof snapshot.identity !== "object") {
    throw new TypeError("snapshot must contain an identity object");
  }
  return {
    ...state,
    files: snapshot.files.map((f) => ({ ...f })),
    nodes: snapshot.nodes.map((n) => ({ ...n })),
    identity: { ...snapshot.identity },
    provider: snapshot.provider ? { ...snapshot.provider } : null,
    demoMode: snapshot.filesSource === "demo" && snapshot.nodesSource === "demo",
    notice: null,
  };
}

export function resetUploadDraft(state: WebState): WebState {
  return {
    ...state,
    upload: { status: "idle", fileName: "", fileSize: 0, note: null, retryable: false },
  };
}

export function dashboardStats(state: WebState): DashboardStats {
  const bytesUsed = state.nodes.reduce((sum, n) => sum + n.usedBytes, 0);
  const bytesAllocated = state.nodes.reduce((sum, n) => sum + n.allocatedBytes, 0);
  const online = state.nodes.filter((n) => n.available);
  const avgScore =
    state.nodes.length === 0 ? 0 : Math.round(state.nodes.reduce((sum, n) => sum + n.score, 0) / state.nodes.length);
  return {
    fileCount: state.files.length,
    totalChunks: state.files.reduce((sum, f) => sum + f.totalChunks, 0),
    bytesUsed,
    bytesAllocated,
    bytesAvailable: Math.max(0, bytesAllocated - bytesUsed),
    nodeCount: state.nodes.length,
    nodesOnline: online.length,
    avgScore,
  };
}
