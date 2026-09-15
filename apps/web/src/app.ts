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
  downloadComplete,
  downloadDecrypting,
  downloadDownloading,
  downloadFailed,
  downloadLocating,
  identityCreationDismissed,
  identityCreationReceived,
  identityLocked,
  identityRecovered,
  identityUnlocked,
  isTransferActive,
  navigate,
  parseHash,
  retryDownload,
  retryUpload,
  selectFileForUpload,
  toggleRecoveryPhraseReveal,
  uploadComplete,
  uploadEncrypting,
  uploadFailed,
  uploadPreparing,
  resetUploadDraft,
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

/**
 * Stage a user-picked file for upload (pure, tested).
 *
 * This is exactly what the `#upload-input` change handler applies:
 * `selectFileForUpload` already yields a clean `ready` draft (replacing
 * any previous draft), so the result must NOT be passed through
 * `resetUploadDraft` — that would wipe the staging back to `idle` and
 * leave the UI stuck on "No file staged" with Upload disabled.
 * Only the file name/size enter state; bytes stay in the File object.
 */
export function stagePickedFile(state: WebState, fileName: string, fileSize: number): WebState {
  return selectFileForUpload(state, fileName, fileSize);
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

interface ApiProviderPayload {
  provider: BackendSnapshot["provider"];
}

/**
 * Fetch the live backend snapshot. Falls back to demo state (with an
 * honest notice) when the backend is unreachable or returns garbage.
 */
async function loadLiveData(state: WebState): Promise<WebState> {
  try {
    const [filesRes, nodesRes, identityRes, providerRes] = await Promise.all([
      fetch("/api/files"),
      fetch("/api/nodes"),
      fetch("/api/identity"),
      fetch("/api/provider"),
    ]);
    if (!filesRes.ok || !nodesRes.ok || !identityRes.ok || !providerRes.ok) {
      throw new Error(
        `backend responded ${filesRes.status}/${nodesRes.status}/${identityRes.status}/${providerRes.status}`,
      );
    }
    const filesJson = (await filesRes.json()) as Partial<ApiFilesPayload>;
    const nodesJson = (await nodesRes.json()) as Partial<ApiNodesPayload>;
    const identityJson = (await identityRes.json()) as Partial<ApiIdentityPayload>;
    const providerJson = (await providerRes.json()) as Partial<ApiProviderPayload>;
    if (!Array.isArray(filesJson.files) || !Array.isArray(nodesJson.nodes) || typeof identityJson.identity !== "object") {
      throw new Error("malformed backend snapshot");
    }
    return applyBackendSnapshot(state, {
      files: filesJson.files,
      nodes: nodesJson.nodes,
      identity: identityJson.identity as BackendSnapshot["identity"],
      filesSource: filesJson.source === "live" ? "live" : "demo",
      nodesSource: nodesJson.source === "live" ? "live" : "demo",
      provider: (providerJson.provider ?? null) as BackendSnapshot["provider"],
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

  async function postApi(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
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

  async function postIdentity(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return postApi(path, body);
  }

  /** Refresh the full live snapshot (files, nodes, identity, provider). */
  async function refreshLiveData(): Promise<void> {
    const refreshed = await loadLiveData(state);
    state = syncFromHash(refreshed);
    render(state);
  }

  function textValue(id: string): string {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el.value.trim() : "";
  }

  /** MiB form field → bytes, or null when invalid. */
  function mebibytesToBytes(id: string): number | null {
    const raw = textValue(id);
    if (raw === "") return null;
    const mb = Number(raw);
    if (!Number.isFinite(mb) || mb <= 0) return null;
    return Math.round(mb * 1024 * 1024);
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
      form.id !== "identity-recover-form" &&
      form.id !== "provider-setup-form" &&
      form.id !== "provider-allocation-form"
    )
      return;
    event.preventDefault();
    if (form.id === "provider-setup-form" || form.id === "provider-allocation-form") {
      void (async () => {
        try {
          if (form.id === "provider-setup-form") {
            const location = textValue("provider-location");
            const capacityBytes = mebibytesToBytes("provider-capacity-mb");
            const portRaw = textValue("provider-port");
            if (location === "" || capacityBytes === null) {
              state = { ...state, notice: "Enter a storage location and a positive allocation in MiB." };
              render(state);
              return;
            }
            const body: Record<string, unknown> = { location, capacityBytes };
            if (portRaw !== "") {
              const port = Number(portRaw);
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                state = { ...state, notice: "Port must be an integer 1–65535 (or blank)." };
                render(state);
                return;
              }
              body["port"] = port;
            }
            const { status, json } = await postApi("/api/provider/setup", body);
            if (status === 200) {
              await refreshLiveData();
              state = { ...state, notice: "Storage sharing is set up. Use Start Sharing to bring the node online." };
            } else {
              state = { ...state, notice: `Sharing setup failed: ${errorText(json, status)}` };
            }
          } else {
            const capacityBytes = mebibytesToBytes("provider-allocation-mb");
            if (capacityBytes === null) {
              state = { ...state, notice: "Enter a positive allocation in MiB." };
              render(state);
              return;
            }
            const { status, json } = await postApi("/api/provider/allocation", { capacityBytes });
            if (status === 200) {
              await refreshLiveData();
            } else {
              state = { ...state, notice: `Allocation update failed: ${errorText(json, status)}` };
            }
          }
        } catch {
          state = { ...state, notice: "Provider request failed — is the server reachable?" };
        }
        render(state);
      })();
      return;
    }
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
          const invalidWord = words.find((w) => !/^[a-z]+$/.test(w));
          if (invalidWord) {
            state = { ...state, notice: `Invalid recovery word: "${invalidWord}". Words must be lowercase letters only.` };
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
    } else if (action === "reveal-phrase") {
      state = toggleRecoveryPhraseReveal(state);
      render(state);
    } else if (action === "copy-phrase") {
      if (state.identityCreation) {
        const text = state.identityCreation.recoveryPhrase.join(" ");
        void navigator.clipboard.writeText(text).then(() => {
          actionEl.textContent = "Copied!";
          setTimeout(() => {
            actionEl.textContent = "Copy phrase";
          }, 1500);
        }).catch(() => {
          // Clipboard API unavailable (e.g. non-HTTPS) — ignore silently
        });
      }
    } else if (action === "toggle-word-reveal") {
      const slot = actionEl.getAttribute("data-word-slot");
      if (!slot) return;
      const input = document.getElementById(`recovery-word-${slot}`) as HTMLInputElement | null;
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      actionEl.textContent = isPassword ? "Hide" : "Show";
      actionEl.setAttribute("aria-label", isPassword ? `Hide word ${slot}` : `Show word ${slot}`);
    } else if (action === "toggle-password") {
      const targetId = actionEl.getAttribute("data-target");
      if (!targetId) return;
      const input = document.getElementById(targetId) as HTMLInputElement | null;
      if (!input) return;
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      actionEl.textContent = isPassword ? "Hide" : "Show";
    } else if (action === "upload-attempt" || action === "upload-retry") {
      const isRetry = action === "upload-retry";
      if (isRetry) {
        if (state.upload.status !== "failed" || !state.upload.retryable || !stagedFile) return;
        state = retryUpload(state);
        if (state.upload.status !== "ready") return;
        render(state);
      } else {
        if (!stagedFile || state.upload.status !== "ready") return;
        if (isTransferActive(state)) return;
      }
      // attemptUpload is a no-op (same reference) when idle, non-ready,
      // or when any transfer is already active — never start a duplicate.
      const beforeUpload = state;
      state = attemptUpload(state);
      if (state === beforeUpload || state.upload.status !== "preparing") return;
      render(state);
      void (async () => {
        let uploadController: AbortController | null = new AbortController();
        const doUploadOnce = async (): Promise<{ ok: boolean; json: Record<string, unknown>; status: number }> => {
          state = uploadPreparing(state);
          render(state);
          await new Promise((r) => setTimeout(r, 50));
          state = uploadEncrypting(state);
          render(state);
          const form = new FormData();
          const fileToSend = stagedFile as File;
          form.append("file", fileToSend, fileToSend.name);
          const res = await fetch("/api/files/upload", { method: "POST", body: form, signal: uploadController!.signal });
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; } catch {}
          return { ok: res.ok, json, status: res.status };
        };
        try {
          let result = await doUploadOnce();
          // One automatic retry for transient failures (network, 5xx, timeout)
          if (!result.ok) {
            const errText = typeof result.json["error"] === "string" ? (result.json["error"] as string) : `status ${result.status}`;
            const lower = errText.toLowerCase();
            const isTransient = /timeout|network|econn|fetch failed|aborted|interrupted|503|502|504|500|temporarily unavailable/i.test(lower) && !/insufficient storage|quota|draining/i.test(lower);
            if (isTransient) {
              await new Promise((r) => setTimeout(r, 300));
              // Back to preparing for the retry so progress is truthful
              state = { ...state, upload: { ...state.upload, status: "preparing", note: "Retrying upload…" } };
              render(state);
              result = await doUploadOnce();
            }
          }
          if (result.ok && typeof result.json["fileId"] === "string") {
            state = uploadComplete(state, {
              fileId: result.json["fileId"] as string,
              filename: result.json["filename"] as string,
              size: result.json["size"] as number,
              totalChunks: result.json["totalChunks"] as number,
            });
            stagedFile = null;
            uploadController = null;
            const refreshed = await loadLiveData(state);
            state = syncFromHash(refreshed);
          } else {
            const errText = typeof result.json["error"] === "string" ? (result.json["error"] as string) : `status ${result.status}`;
            state = uploadFailed(state, errText);
            if (!state.upload.retryable) stagedFile = null;
            uploadController = null;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "network error";
          const isAbort = err instanceof DOMException && err.name === "AbortError";
          state = uploadFailed(state, isAbort ? "Upload interrupted. Please try again." : msg);
          if (!state.upload.retryable && !(isAbort)) stagedFile = null;
          uploadController = null;
        }
        render(state);
      })();
    } else if (action === "upload-reset") {
      stagedFile = null;
      state = resetUploadDraft(state);
      render(state);
    } else if (action === "provider-start" || action === "provider-stop" || action === "provider-release") {
      if (action === "provider-release") {
        const confirmed = typeof confirm === "function"
          ? confirm("Release shared storage? This is refused while any pieces remain.")
          : true;
        if (!confirmed) return;
      }
      void (async () => {
        try {
          const path = action === "provider-start"
            ? "/api/provider/start"
            : action === "provider-stop"
              ? "/api/provider/stop"
              : "/api/provider/release";
          const body = action === "provider-release" ? { confirm: true } : {};
          const { status, json } = await postApi(path, body);
          if (status === 200) {
            await refreshLiveData();
            if (action === "provider-release") {
              state = { ...state, notice: "Shared storage released." };
              render(state);
            }
          } else {
            state = { ...state, notice: `Sharing request failed: ${errorText(json, status)}` };
            render(state);
          }
        } catch {
          state = { ...state, notice: "Provider request failed — is the server reachable?" };
          render(state);
        }
      })();
    } else if (action === "download-attempt" || action === "download-retry") {
      const fileId = actionEl.getAttribute("data-file-id") ?? "";
      const isRetry = action === "download-retry";
      // attemptDownload/retryDownload return the same reference when
      // blocked (another transfer active, unknown file, non-retryable) —
      // never start a duplicate fetch.
      const beforeDownload = state;
      if (isRetry) {
        state = retryDownload(state);
        if (state === beforeDownload) return;
        if (state.download.status !== "locating" || state.download.fileId !== fileId) return;
        render(state);
      } else {
        state = attemptDownload(state, fileId);
        if (state === beforeDownload) return;
        render(state);
        if (
          state.download.status !== "locating" &&
          state.download.status !== "active" &&
          state.download.fileId !== fileId
        )
          return;
        if (state.download.status === "active") {
          // Backward compat: treat active as locating for new flow
          state = { ...state, download: { ...state.download, status: "locating" as const } };
          render(state);
        }
      }
      // Prevent concurrent transfers
      if (
        state.upload.status === "preparing" ||
        state.upload.status === "encrypting" ||
        state.upload.status === "storing"
      )
        return;
      const activeFileId = fileId;
      void (async () => {
        let downloadController: AbortController | null = new AbortController();
        const doDownloadOnce = async (): Promise<{ ok: boolean; blob?: Blob; error?: string }> => {
          // Locating (manifest + key lookup) happens server-side before bytes stream;
          // downloading is the actual piece fetch. Keep the truthful stage order:
          // locating → downloading → decrypting → verifying
          if (state.download.status === "locating") {
            state = downloadLocating(state);
            render(state);
          }
          const res = await fetch(`/api/files/${encodeURIComponent(activeFileId)}/download`, {
            signal: downloadController!.signal,
          });
          if (!res.ok) {
            let errText = `status ${res.status}`;
            try {
              const errJson = (await res.json()) as Record<string, unknown>;
              if (typeof errJson["error"] === "string") errText = errJson["error"] as string;
            } catch {}
            return { ok: false, error: errText };
          }
          const blob = await res.blob();
          // Server already verified piece hashes and decrypted before sending;
          // frontend shows decrypting→verifying briefly as truthful stages
          // before handing bytes to the browser.
          state = downloadDownloading(state);
          render(state);
          await new Promise((r) => setTimeout(r, 30));
          state = downloadDecrypting(state);
          render(state);
          await new Promise((r) => setTimeout(r, 30));
          return { ok: true, blob };
        };
        try {
          let result = await doDownloadOnce();
          if (!result.ok) {
            const lower = (result.error ?? "").toLowerCase();
            const isTransient = /timeout|network|econn|fetch failed|aborted|interrupted|503|502|504|500|temporarily unavailable|unavailable from/i.test(lower) && !/corrupt|hash mismatch|size mismatch|decryption failed|wrong key|invalid file id|not found|key unavailable/i.test(lower);
            if (isTransient) {
              await new Promise((r) => setTimeout(r, 300));
              state = { ...state, download: { ...state.download, status: "locating", note: "Retrying download…" } };
              render(state);
              result = await doDownloadOnce();
            }
          }
          if (!result.ok || !result.blob) {
            state = downloadFailed(state, result.error ?? "download failed");
            downloadController = null;
            render(state);
            return;
          }
          const blob = result.blob;
          const filename = state.download.filename || "download";
          const url = URL.createObjectURL(blob);
          try {
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename || "download";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }
          state = downloadComplete(state, { fileId: activeFileId, filename, size: blob.size });
          downloadController = null;
        } catch (err) {
          const isAbort = err instanceof DOMException && err.name === "AbortError";
          state = downloadFailed(state, isAbort ? "Download interrupted. Please try again." : err instanceof Error ? err.message : "network error");
          downloadController = null;
        }
        render(state);
      })();
    } else if (action === "delete-attempt") {
      const fileId = actionEl.getAttribute("data-file-id") ?? "";
      state = attemptDelete(state, fileId);
      render(state);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id === "upload-input" && target instanceof HTMLInputElement) {
      const picked = target.files?.[0];
      if (picked) {
        // Name/size only — file bytes are never read here; they travel
        // inside the staged File reference straight to the upload POST.
        stagedFile = picked;
        state = stagePickedFile(state, picked.name, picked.size);
        render(state);
      }
    }
  });

  document.addEventListener("paste", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !target.matches("[data-word-input]")) return;
    const pasted = event.clipboardData?.getData("text") ?? "";
    if (!pasted) return;
    const words = pasted
      .trim()
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean);
    const errorEl = document.getElementById("phrase-validation-error");
    if (words.length > 12) {
      if (errorEl) {
        errorEl.textContent = `Too many words (${words.length}). Recovery phrases must be exactly 12 words.`;
        errorEl.hidden = false;
      }
      event.preventDefault();
      return;
    }
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
    event.preventDefault();
    for (let i = 0; i < 12; i++) {
      const input = document.getElementById(`recovery-word-${i + 1}`) as HTMLInputElement | null;
      if (input) {
        input.value = i < words.length ? (words[i] ?? "") : "";
      }
    }
    const nextEmpty = words.length < 12 ? words.length + 1 : 12;
    const focusTarget = document.getElementById(`recovery-word-${nextEmpty}`);
    if (focusTarget) focusTarget.focus();
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
}
