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
  identityCreationDismissed,
  identityCreationReceived,
  identityLocked,
  identityRecovered,
  identityUnlocked,
  navigate,
  parseHash,
  resetUploadDraft,
  selectFileForUpload,
  uploadComplete,
  uploadEncrypting,
  uploadFailed,
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
  let stagedFile: File | null = null;
  render(state);
  void loadLiveData(state).then((next) => {
    state = syncFromHash(next);
    render(state);
  });

  window.addEventListener("hashchange", () => {
    state = syncFromHash(state);
    render(state);
  });

  async function postIdentity(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body; status below still guides the message.
    }
    return { status: res.status, json };
  }

  function inputValue(id: string): string {
    const el = document.getElementById(id);
    const value = el instanceof HTMLInputElement ? el.value : "";
    // Clear immediately: passwords live only in this call frame.
    if (el instanceof HTMLInputElement) el.value = "";
    return value;
  }

  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement | null;
    if (!form || form.tagName !== "FORM") return;
    if (
      form.id !== "identity-create-form" &&
      form.id !== "identity-unlock-form" &&
      form.id !== "identity-recover-form"
    )
      return;
    event.preventDefault();
    void (async () => {
      try {
        if (form.id === "identity-create-form") {
          const password = inputValue("create-password");
          const confirm = inputValue("create-confirm");
          if (password === "" || password !== confirm) {
            state = { ...state, notice: "Passwords do not match or are empty." };
            render(state);
            return;
          }
          const { status, json } = await postIdentity("/api/identity/create", { password });
          if (status === 200 && typeof json["publicKey"] === "string" && Array.isArray(json["recoveryPhrase"])) {
            state = identityCreationReceived(state, {
              publicKey: json["publicKey"] as string,
              recoveryPhrase: (json["recoveryPhrase"] as unknown[]).map(String),
            });
          } else if (status === 409) {
            state = { ...state, notice: "An identity is already configured on this server." };
          } else {
            state = { ...state, notice: `Identity creation failed: ${errorText(json, status)}` };
          }
        } else if (form.id === "identity-recover-form") {
          const password = inputValue("recover-password");
          const confirm = inputValue("recover-confirm");
          if (password === "" || password !== confirm) {
            state = { ...state, notice: "Passwords do not match or are empty." };
            render(state);
            return;
          }
          const words: string[] = [];
          for (let i = 1; i <= 12; i++) {
            const w = inputValue(`recovery-word-${i}`).trim().toLowerCase();
            words.push(w);
          }
          if (words.some((w) => w === "")) {
            state = { ...state, notice: "All 12 recovery words are required." };
            render(state);
            return;
          }
          const replaceEl = document.getElementById("recover-confirm-replace");
          const confirmReplace = replaceEl instanceof HTMLInputElement && replaceEl.checked;
          const { status, json } = await postIdentity("/api/identity/recover", {
            phrase: words,
            password,
            confirmReplace,
          });
          if (status === 200 && typeof json["publicKey"] === "string") {
            state = identityRecovered(state, json["publicKey"] as string);
            state = { ...state, notice: "Identity recovered successfully." };
          } else if (status === 409) {
            state = { ...state, notice: "A keystore already exists. Check 'Replace existing keystore' to overwrite." };
          } else if (status === 400) {
            state = { ...state, notice: `Recovery failed: ${errorText(json, status)}` };
          } else {
            state = { ...state, notice: `Recovery failed: ${errorText(json, status)}` };
          }
        } else {
          const password = inputValue("unlock-password");
          if (password === "") {
            state = { ...state, notice: "Enter the keystore password." };
            render(state);
            return;
          }
          const { status, json } = await postIdentity("/api/identity/unlock", { password });
          if (status === 200 && typeof json["publicKey"] === "string") {
            state = identityUnlocked(state, json["publicKey"] as string);
          } else if (status === 401) {
            state = { ...state, notice: "Incorrect password." };
          } else if (status === 404) {
            state = { ...state, notice: "No keystore found on this server." };
          } else {
            state = { ...state, notice: `Unlock failed: ${errorText(json, status)}` };
          }
        }
      } catch {
        state = { ...state, notice: "Identity request failed — is the server reachable?" };
      }
      render(state);
    })();
  });

  function errorText(json: Record<string, unknown>, status: number): string {
    return typeof json["error"] === "string" ? (json["error"] as string) : `unexpected status ${status}`;
  }

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest?.("[data-action]") as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.getAttribute("data-action");
    if (action === "notice-dismiss") {
      state = dismissNotice(state);
      render(state);
    } else if (action === "creation-dismiss") {
      state = identityCreationDismissed(state);
      render(state);
    } else if (action === "identity-lock") {
      void (async () => {
        try {
          await postIdentity("/api/identity/lock", {});
        } catch {
          // Lock is best-effort client-side regardless.
        }
        state = identityLocked(state);
        render(state);
      })();
    } else if (action === "upload-attempt") {
      if (!stagedFile || state.upload.status !== "ready") return;
      state = attemptUpload(state);
      render(state);
      void (async () => {
        try {
          state = uploadEncrypting(state);
          render(state);
          const form = new FormData();
          form.append("file", stagedFile, stagedFile.name);
          const res = await fetch("/api/files/upload", { method: "POST", body: form });
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; } catch {}
          if (res.ok && typeof json["fileId"] === "string") {
            state = uploadComplete(state, {
              fileId: json["fileId"] as string,
              filename: json["filename"] as string,
              size: json["size"] as number,
              totalChunks: json["totalChunks"] as number,
            });
            stagedFile = null;
            const refreshed = await loadLiveData(state);
            state = syncFromHash(refreshed);
          } else {
            const errText = typeof json["error"] === "string" ? (json["error"] as string) : `status ${res.status}`;
            state = uploadFailed(state, errText);
            stagedFile = null;
          }
        } catch (err) {
          state = uploadFailed(state, err instanceof Error ? err.message : "network error");
          stagedFile = null;
        }
        render(state);
      })();
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
        stagedFile = picked;
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
