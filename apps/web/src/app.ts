/**
 * OpenStore Web Frontend — DOM bootstrap (OPENSTORE-023).
 *
 * Thin imperative shell around the pure store/views modules: hash
 * routing, event delegation, and re-rendering. File inputs expose only
 * name/size — contents are never read.
 */

import {
  attemptDelete,
  attemptDownload,
  attemptUpload,
  createInitialState,
  dashboardStats,
  dismissNotice,
  navigate,
  parseHash,
  resetUploadDraft,
  selectFileForUpload,
} from "./store.js";
import { applyBackendSnapshot } from "./store.js";
import type { BackendSnapshot } from "../backend.js";
import type { WebState } from "./store.js";
import { renderApp } from "./views.js";

function mount(): HTMLElement | null {
  return document.getElementById("app");
}

function render(state: WebState): void {
  const root = mount();
  if (!root) return;
  root.innerHTML = renderApp(state, dashboardStats(state));
}

function syncFromHash(state: WebState): WebState {
  return navigate(state, parseHash(window.location.hash));
}

interface ApiFilesPayload {
  files: BackendSnapshot["files"];
  source: BackendSnapshot["filesSource"];
}

interface ApiNodesPayload {
  nodes: BackendSnapshot["nodes"];
  source: BackendSnapshot["nodesSource"];
}

interface ApiIdentityPayload {
  identity: BackendSnapshot["identity"];
}

/**
 * Fetch the live backend snapshot. Falls back to demo state (with an
 * honest notice) when the backend is unreachable or returns garbage.
 */
async function loadLiveData(state: WebState): Promise<WebState> {
  try {
    const [filesRes, nodesRes, identityRes] = await Promise.all([
      fetch("/api/files"),
      fetch("/api/nodes"),
      fetch("/api/identity"),
    ]);
    if (!filesRes.ok || !nodesRes.ok || !identityRes.ok) {
      throw new Error(`backend responded ${filesRes.status}/${nodesRes.status}/${identityRes.status}`);
    }
    const filesJson = (await filesRes.json()) as Partial<ApiFilesPayload>;
    const nodesJson = (await nodesRes.json()) as Partial<ApiNodesPayload>;
    const identityJson = (await identityRes.json()) as Partial<ApiIdentityPayload>;
    if (!Array.isArray(filesJson.files) || !Array.isArray(nodesJson.nodes) || typeof identityJson.identity !== "object") {
      throw new Error("malformed backend snapshot");
    }
    return applyBackendSnapshot(state, {
      files: filesJson.files,
      nodes: nodesJson.nodes,
      identity: identityJson.identity as BackendSnapshot["identity"],
      filesSource: filesJson.source === "live" ? "live" : "demo",
      nodesSource: nodesJson.source === "live" ? "live" : "demo",
    });
  } catch {
    return { ...state, notice: "Live backend unavailable — showing demo data." };
  }
}

export function startApp(): void {
  let state: WebState = syncFromHash(createInitialState());
  render(state);
  void loadLiveData(state).then((next) => {
    state = syncFromHash(next);
    render(state);
  });

  window.addEventListener("hashchange", () => {
    state = syncFromHash(state);
    render(state);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest?.("[data-action]") as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.getAttribute("data-action");
    if (action === "notice-dismiss") {
      state = dismissNotice(state);
      render(state);
    } else if (action === "upload-attempt") {
      state = attemptUpload(state);
      render(state);
    } else if (action === "delete-attempt" || action === "download-attempt") {
      const fileId = actionEl.getAttribute("data-file-id") ?? "";
      state = action === "delete-attempt" ? attemptDelete(state, fileId) : attemptDownload(state, fileId);
      render(state);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id === "upload-input" && target instanceof HTMLInputElement) {
      const picked = target.files?.[0];
      if (picked) {
        // Name + size only. Contents are never read in this demo build.
        state = resetUploadDraft(selectFileForUpload(state, picked.name, picked.size));
        render(state);
      }
    }
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
}
