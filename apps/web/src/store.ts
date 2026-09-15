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
import type { BackendSnapshot, IdentityCreation } from "../backend.js";

export type ViewId = "dashboard" | "files" | "upload" | "nodes" | "settings";

export const VIEWS: { id: ViewId; label: string; hash: string }[] = [
  { id: "dashboard", label: "Dashboard", hash: "#/dashboard" },
  { id: "files", label: "My Files", hash: "#/files" },
  { id: "upload", label: "Upload", hash: "#/upload" },
  { id: "nodes", label: "Storage Nodes", hash: "#/nodes" },
  { id: "settings", label: "Settings", hash: "#/settings" },
];

export type UploadStatus = "idle" | "ready" | "blocked";

export interface UploadDraft {
  status: UploadStatus;
  fileName: string;
  fileSize: number;
  note: string | null;
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
  upload: UploadDraft;
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
    upload: { status: "idle", fileName: "", fileSize: 0, note: null },
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

/** Stage a picked file for upload. File bytes are never read or stored. */
export function selectFileForUpload(state: WebState, fileName: string, fileSize: number): WebState {
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
      note: "Demo build: the upload backend is not connected yet. Picking a file stages it locally only.",
    },
  };
}

/**
 * Attempt an upload. Always honest: with no backend wired, nothing is
 * stored and the file list never changes.
 */
export function attemptUpload(state: WebState): WebState {
  if (state.upload.status === "idle") {
    return { ...state, notice: "Select a file first." };
  }
  return {
    ...state,
    upload: { ...state.upload, status: "blocked" },
    notice: "Upload not performed — backend integration is pending. Your file was not stored anywhere.",
  };
}

/**
 * Attempt a download. Always honest: nothing is fetched or written.
 */
export function attemptDownload(state: WebState, fileId: string): WebState {
  const file = state.files.find((f) => f.fileId === fileId);
  if (!file) {
    return { ...state, notice: `No file with ID "${fileId}".` };
  }
  return {
    ...state,
    notice: `Download not performed — backend integration is pending. "${file.filename}" was not fetched.`,
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
  return { ...state, identityCreation: null };
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
    demoMode: snapshot.filesSource === "demo" && snapshot.nodesSource === "demo",
    notice: null,
  };
}

export function resetUploadDraft(state: WebState): WebState {
  return {
    ...state,
    upload: { status: "idle", fileName: "", fileSize: 0, note: null },
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
