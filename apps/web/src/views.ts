/**
 * OpenStore Web Frontend — pure view renderers (OPENSTORE-023).
 *
 * Every screen is a pure function of {@link WebState} returning an HTML
 * string. Dynamic content is escaped; only safe metadata is rendered.
 * No uploads, deletes, or downloads are performed or faked here.
 */

import { availabilityLabel, esc, formatBytes, formatDateTime, healthGrade, truncateId } from "./format.js";
import { VIEWS } from "./store.js";
import type { ViewId, WebState } from "./store.js";
import type { DashboardStats } from "./types.js";

function navHtml(active: ViewId): string {
  const links = VIEWS.map(
    (v) =>
      `<a href="${v.hash}" data-nav="${v.id}" class="nav-link${v.id === active ? " active" : ""}"${
        v.id === active ? ' aria-current="page"' : ""
      }>${esc(v.label)}</a>`,
  ).join("");
  return `<nav class="nav" aria-label="Primary">${links}</nav>`;
}

function noticeHtml(notice: string | null): string {
  if (!notice) return "";
  return `<div class="notice" role="status"><span>${esc(notice)}</span><button type="button" data-action="notice-dismiss">Dismiss</button></div>`;
}

function scoreBar(score: number): string {
  const grade = healthGrade(score);
  const safe = Math.min(100, Math.max(0, Math.round(score)));
  return `<span class="score score-${grade.class}"><span class="score-bar" style="width:${safe}%"></span><span class="score-label">${safe} · ${esc(grade.label)}</span></span>`;
}

function capacityBar(used: number, allocated: number): string {
  const pct = allocated > 0 ? Math.min(100, Math.round((used / allocated) * 100)) : 0;
  return `<span class="meter"><span class="meter-fill" style="width:${pct}%"></span></span>`;
}

export function renderDashboard(state: WebState, stats: DashboardStats): string {
  const grade = healthGrade(stats.avgScore);
  return `
  <section aria-label="Storage overview">
    <h2>Dashboard</h2>
    <div class="cards">
      <div class="card"><h3>Storage used</h3><p class="stat">${esc(formatBytes(stats.bytesUsed))}</p><p class="sub">of ${esc(formatBytes(stats.bytesAllocated))} allocated</p></div>
      <div class="card"><h3>Available</h3><p class="stat">${esc(formatBytes(stats.bytesAvailable))}</p><p class="sub">${stats.fileCount} file(s) · ${stats.totalChunks} chunk(s)</p></div>
      <div class="card"><h3>Nodes</h3><p class="stat">${stats.nodesOnline}/${stats.nodeCount} online</p><p class="sub">avg reliability ${stats.avgScore} · ${esc(grade.label)}</p></div>
    </div>
  </section>`;
}

export function renderFiles(state: WebState): string {
  const isUploadActive =
    state.upload.status === "preparing" ||
    state.upload.status === "encrypting" ||
    state.upload.status === "storing";
  const rows =
    state.files.length === 0
      ? `<tr><td colspan="5" class="empty">No files yet. Uploads land here once the backend is connected.</td></tr>`
      : state.files
          .map((f) => {
            const isThisDownloading =
              (state.download.status === "locating" ||
                state.download.status === "downloading" ||
                state.download.status === "decrypting" ||
                state.download.status === "verifying" ||
                state.download.status === "active") &&
              state.download.fileId === f.fileId;
            const isAnyDownloading =
              state.download.status === "locating" ||
              state.download.status === "downloading" ||
              state.download.status === "decrypting" ||
              state.download.status === "verifying" ||
              state.download.status === "active";
            const busy = isUploadActive || isAnyDownloading;
            const retryThis = state.download.status === "failed" && state.download.retryable && state.download.fileId === f.fileId;
            return `<tr>
        <td data-label="Name">${esc(f.filename)}<br><span class="muted">${esc(truncateId(f.fileId, 18))}</span></td>
        <td data-label="Size">${esc(formatBytes(f.size))}</td>
        <td data-label="Chunks">${f.totalChunks}</td>
        <td data-label="Created">${esc(formatDateTime(f.createdAt ?? 0))}</td>
        <td data-label="Actions" class="actions">
          <button type="button" data-action="download-attempt" data-file-id="${esc(f.fileId)}"${isThisDownloading || busy ? " disabled" : ""}>${isThisDownloading ? esc(state.download.note ?? "Downloading…") : "Download"}</button>
          ${retryThis ? `<button type="button" data-action="download-retry" data-file-id="${esc(f.fileId)}">Retry</button>` : ""}
          <button type="button" data-action="delete-attempt" data-file-id="${esc(f.fileId)}" class="danger">Delete</button>
        </td>
      </tr>`;
          })
          .join("");
  const downloadLine =
    state.download.status === "idle"
      ? ""
      : `<p class="muted" role="status">${esc(state.download.note ?? "")}${state.download.status === "failed" && state.download.retryable ? " — retry available." : ""}</p>`;
  return `
  <section aria-label="My files">
    <h2>My Files</h2>
    <p class="muted">Safe metadata only. File contents and keys never appear here.</p>
    ${downloadLine}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Size</th><th>Chunks</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

export function renderUpload(state: WebState): string {
  const draft = state.upload;
  const isPreparing = draft.status === "preparing";
  const isEncrypting = draft.status === "encrypting";
  const isStoring = draft.status === "storing";
  const isUploadActive = isPreparing || isEncrypting || isStoring;
  const isDownloadActive =
    state.download.status === "locating" ||
    state.download.status === "downloading" ||
    state.download.status === "decrypting" ||
    state.download.status === "verifying" ||
    state.download.status === "active";
  const anyActive = isUploadActive || isDownloadActive;
  const stageLabel =
    isPreparing ? "Preparing…" :
    isEncrypting ? "Encrypting…" :
    isStoring ? "Storing encrypted replicas…" :
    draft.status === "complete" ? "Complete" :
    draft.status === "failed" ? "Failed" : "";
  const staged =
    draft.status === "idle"
      ? `<p class="muted">No file staged.</p>`
      : `<div class="staged">
          <p><strong>${esc(draft.fileName)}</strong> (${esc(formatBytes(draft.fileSize))})</p>
          ${draft.note ? `<p class="muted">${esc(draft.note)}</p>` : ""}
          ${draft.status !== "ready" ? `
          <div class="progress" role="progressbar" aria-label="${esc(stageLabel)}">
            <span class="progress-fill${draft.status === "complete" ? " progress-good" : draft.status === "failed" ? " progress-bad" : " progress-active"}"></span>
          </div>
          <p class="muted">${esc(stageLabel)}</p>` : ""}
          ${draft.status === "ready" ? `<p class="muted">Ready to upload.</p>` : ""}
          ${draft.status === "complete" ? `<p class="muted">File encrypted, chunked, and stored on nodes.</p>` : ""}
          ${draft.status === "failed" ? `<p class="muted">${esc(draft.note ?? "Upload failed.")}${draft.retryable ? " You can retry." : " Check that storage nodes are running."}</p>` : ""}
        </div>`;
  // Conflicting actions stay disabled while ANY transfer is active:
  // an upload must not start during a download and vice versa.
  const uploadDisabled = draft.status === "idle" || isUploadActive || isDownloadActive;
  return `
  <section aria-label="Upload">
    <h2>Upload</h2>
    <p class="muted">Pick a file to upload. Your browser sends it to the client backend on this server, which encrypts and chunks it before storage — storage nodes only ever receive encrypted data.</p>
    <div class="upload-box">
      <label class="file-label">Choose file
        <input id="upload-input" type="file" />
      </label>
      ${staged}
      <div class="row">
        <button type="button" data-action="upload-attempt" ${uploadDisabled ? "disabled" : ""}>Upload</button>
        ${draft.status === "failed" && draft.retryable ? `<button type="button" data-action="upload-retry">Retry</button>` : ""}
        ${draft.status === "failed" || draft.status === "complete" ? `<button type="button" data-action="upload-reset">Clear</button>` : ""}
      </div>
    </div>
  </section>`;
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function providerHtml(state: WebState): string {
  const provider = state.provider;
  if (state.demoMode || !provider) {
    // In live mode, provider === null is a loading state; show honest placeholder without stale data.
    const loading = !state.demoMode && !provider ? `<p class="muted">Loading provider status…</p>` : "";
    return `
    <div class="card">
      <h3>My Storage Node</h3>
      <p class="muted">Sharing storage is unavailable in demo mode. Start the server with a manifest store and registry for the live provider.</p>
      ${loading}
    </div>`;
  }
  if (!provider.configured) {
    return `
    <div class="card">
      <h3>Share Storage</h3>
      <p class="muted">Contribute part of your disk to the network. You choose an explicit allocation — OpenStore never claims free space on its own — inside a dedicated directory the node cannot leave.</p>
      <form id="provider-setup-form" autocomplete="off">
        <div class="form-row"><label>Storage location (empty directory path)
          <input id="provider-location" name="location" type="text" autocomplete="off" required minlength="1" placeholder="./data/share" />
        </label></div>
        <div class="form-row"><label>Allocation (MiB)
          <input id="provider-capacity-mb" name="capacityMB" type="number" min="1" step="1" required placeholder="512" />
        </label></div>
        <div class="form-row"><label>Port (optional, blank for ephemeral)
          <input id="provider-port" name="port" type="number" min="1" max="65535" step="1" placeholder="4101" />
        </label></div>
        <div class="row"><button type="submit">Set up sharing</button></div>
      </form>
      <p class="muted">Capacity and contribution metrics feed a future rewards system. No earnings exist yet.</p>
    </div>`;
  }
  // Authoritative lifecycle: sharing → draining → released (058-060). UI reflects backend, never invents.
  const lifecycle = (provider as unknown as { lifecycle?: string }).lifecycle ?? (provider.draining ? "draining" : "sharing");
  const readiness = (provider as unknown as { readiness?: string }).readiness ?? provider.state;
  const placementEligible = (provider as unknown as { placementEligible?: boolean }).placementEligible ?? false;
  const placementReason = (provider as unknown as { placementReason?: string }).placementReason ?? "unknown";
  const conditions = ((provider as unknown as { conditions?: Array<{ code: string; severity: string; message: string }> }).conditions ?? []) as Array<{ code: string; severity: string; message: string }>;
  const drainReadiness = (provider as unknown as { drainReadiness?: { ready: boolean; reason: string; remainingPieces: number; remainingBytes: number } }).drainReadiness;
  const releaseReadiness = (provider as unknown as { releaseReadiness?: { ready: boolean; reason: string; remainingPieces: number; remainingBytes: number } }).releaseReadiness;
  // State pill reflects lifecycle + node liveness; released is distinct and remains unavailable until resume.
  const statePill =
    lifecycle === "released" || provider.state === "released"
      ? `<span class="pill pill-off">Released</span>`
      : provider.state === "running"
        ? `<span class="pill pill-on">Sharing</span>`
        : provider.state === "draining" || lifecycle === "draining"
          ? `<span class="pill pill-off">Draining</span>`
          : provider.state === "stopped"
            ? `<span class="pill pill-off">Stopped</span>`
            : `<span class="pill pill-off">Offline</span>`;
  const capacity = provider.capacity;
  const reserved = (capacity as unknown as { reservedBytes?: number })?.reservedBytes ?? 0;
  const capacityLine = capacity
    ? `<p>Allocation: ${esc(formatBytes(capacity.allocatedBytes))} · Used: ${esc(formatBytes(capacity.usedBytes))} · Reserved: ${esc(formatBytes(reserved))} · Available: ${esc(formatBytes(capacity.availableBytes))}${capacityBar(capacity.usedBytes, capacity.allocatedBytes)}</p>`
    : `<p class="muted">Allocation: unavailable — coordinator or node unreachable.</p>`;
  const filesystemLine = provider.filesystem
    ? `<p class="muted">Filesystem total: ${esc(formatBytes(provider.filesystem.totalBytes))} · free: ${esc(formatBytes(provider.filesystem.freeBytes))}</p>`
    : `<p class="muted">Filesystem: unavailable</p>`;
  const piecesLine = provider.pieces
    ? `<p class="muted">Stored pieces: ${provider.pieces.count} (${esc(formatBytes(provider.pieces.bytes))})</p>`
    : "";
  const nodeLine = provider.nodeId
    ? `<p class="muted">Node: ${esc(truncateId(provider.nodeId, 16))}${provider.baseUrl ? `<br>${esc(provider.baseUrl)}` : ""}</p>`
    : "";
  const healthLine = provider.reliability
    ? `<p class="muted">Reliability ${provider.reliability.score} · Storage health ${provider.reliability.storageScore} · Uptime ${esc(formatUptime(provider.uptimeMs))}</p>`
    : `<p class="muted">Uptime ${esc(formatUptime(provider.uptimeMs))}</p>`;
  const eligibilityLine = `<p class="muted">Placement: ${placementEligible ? `<span class="pill pill-on">Eligible</span>` : `<span class="pill pill-off">Not eligible</span>`} <span class="muted">(${esc(placementReason)})</span></p>`;
  const readinessLine = `<p class="muted">Readiness: ${esc(String(readiness))} · Lifecycle: ${esc(String(lifecycle))}</p>`;
  const conditionsLine = conditions.length
    ? `<ul class="muted">${conditions.map((c) => `<li><strong>${esc(c.code)}</strong> [${esc(c.severity)}] ${esc(c.message)}</li>`).join("")}</ul>`
    : "";
  const drainingWarning =
    lifecycle === "draining" || provider.state === "draining"
      ? `<p class="warning" role="alert"><strong>Draining:</strong> this node no longer accepts new pieces. Existing pieces stay available until re-replication lands. Storage is released only after every piece is gone.</p>`
      : "";
  const releasedWarning =
    lifecycle === "released" || provider.state === "released"
      ? `<p class="warning" role="alert"><strong>Released:</strong> allocation is released and not eligible for placement. Use Resume Sharing to rejoin; this requires explicit confirmation and remains drained until re-registered.</p>`
      : "";
  const offlineWarning =
    provider.state === "offline"
      ? `<p class="warning" role="alert"><strong>Offline:</strong> the provider node process is unreachable. Your pieces stay on disk; use Start Sharing to bring the node back.</p>`
      : "";
  const coordinatorWarning =
    !provider.reliability && provider.state !== "unconfigured"
      ? `<p class="warning" role="alert"><strong>Coordinator:</strong> registry unavailable or stale discovery — placement is paused until fresh coordinator data.</p>`
      : "";
  const drainInspect = drainReadiness
    ? `<p class="muted">Drain readiness: ${drainReadiness.ready ? "ready" : "not ready"} (${esc(drainReadiness.reason)}) · remaining: ${drainReadiness.remainingPieces} pieces (${esc(formatBytes(drainReadiness.remainingBytes))})</p>`
    : "";
  const releaseInspect = releaseReadiness
    ? `<p class="muted">Release readiness: ${releaseReadiness.ready ? "ready — release allowed when confirmed" : "not ready"} (${esc(releaseReadiness.reason)}) · remaining: ${releaseReadiness.remainingPieces} pieces (${esc(formatBytes(releaseReadiness.remainingBytes))})</p>`
    : "";
  const insufficientWarning =
    capacity && capacity.availableBytes <= 0 && lifecycle === "sharing"
      ? `<p class="warning" role="alert"><strong>Capacity:</strong> allocation exhausted. Increase allocation when safe to accept new placements.</p>`
      : "";
  // Controls reflect authoritative backend state (068: stopped+sharing=Start Sharing, sharing+running=Begin Draining).
  // Draining/released safety rules unchanged: released/draining remain Resume Sharing via provider-start; backend remains authoritative.
  let controls = "";
  if (lifecycle === "released" || provider.state === "released") {
    controls = `<div class="row"><button type="button" data-action="provider-start">Resume Sharing</button></div>`;
  } else if (lifecycle === "draining" || provider.state === "draining") {
    controls = `<div class="row"><button type="button" data-action="provider-start">Resume Sharing</button></div>`;
  } else if (lifecycle === "sharing" && provider.state === "running") {
    controls = `<div class="row"><button type="button" data-action="provider-stop">Begin Draining</button></div>`;
  } else if (provider.state === "stopped" && lifecycle === "sharing") {
    controls = `<div class="row"><button type="button" data-action="provider-start">Start Sharing</button></div>`;
  } else {
    controls = `<div class="row"><button type="button" data-action="provider-start">Start Sharing</button></div>`;
  }
  // Allocation controls: increase always allowed when safe, decrease only when usage permits (backend validates).
  // Release remains fail-closed until readiness says ready.
  return `
    <div class="card">
      <h3>My Storage Node</h3>
      <p>Status: ${statePill}</p>
      <p class="muted">Location: ${esc(provider.storageDir ?? "—")}</p>
      ${capacityLine}
      ${filesystemLine}
      ${piecesLine}
      ${nodeLine}
      ${healthLine}
      ${eligibilityLine}
      ${readinessLine}
      ${conditionsLine}
      ${drainInspect}
      ${releaseInspect}
      ${drainingWarning}
      ${releasedWarning}
      ${offlineWarning}
      ${coordinatorWarning}
      ${insufficientWarning}
      ${controls}
      <form id="provider-allocation-form" autocomplete="off">
        <h3>Change allocation (MiB)</h3>
        <p class="muted">Increasing is allowed when filesystem space permits; decreasing is refused while usage or reservations exceed the target.</p>
        <div class="form-row"><label>Allocation (MiB)
          <input id="provider-allocation-mb" name="capacityMB" type="number" min="1" step="1" required />
        </label></div>
        <div class="row"><button type="submit">Update allocation</button></div>
      </form>
      <div class="row"><button type="button" data-action="provider-release" class="danger">Release storage</button></div>
      <p class="muted">Release is refused while any pieces remain — replicas are never deleted silently. Draining rejects new placement while preserving reads and repair migration. Capacity and contribution metrics feed a future rewards system. No earnings exist yet.</p>
    </div>`;
}

export function renderNodes(state: WebState): string {
  const ownNodeId = state.provider?.nodeId ?? null;
  const remote = ownNodeId ? state.nodes.filter((n) => n.id !== ownNodeId) : state.nodes;
  const rows = remote
    .map(
      (n) => `<tr>
      <td data-label="Node">${esc(truncateId(n.id, 16))}<br><span class="muted">${esc(n.baseUrl)}</span></td>
      <td data-label="Status"><span class="pill ${n.available ? "pill-on" : "pill-off"}">${esc(availabilityLabel(n.available))}</span></td>
      <td data-label="Capacity">${esc(formatBytes(n.usedBytes))} / ${esc(formatBytes(n.allocatedBytes))}${capacityBar(n.usedBytes, n.allocatedBytes)}</td>
      <td data-label="Reliability">${scoreBar(n.score)}</td>
      <td data-label="Storage health">${scoreBar(n.storageScore)}</td>
    </tr>`,
    )
    .join("");
  return `
  <section aria-label="Storage nodes">
    <h2>Storage Nodes</h2>
    ${providerHtml(state)}
    <h3>Network storage nodes</h3>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Node</th><th>Status</th><th>Capacity</th><th>Reliability</th><th>Storage health</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

export function renderSettings(state: WebState): string {
  if (state.identityCreation) {
    const revealed = state.recoveryPhraseRevealed;
    const words = state.identityCreation.recoveryPhrase
      .map(
        (word, index) =>
          `<li><span class="word-index">${index + 1}</span> <span class="${revealed ? "word-revealed" : "word-masked"}">${revealed ? esc(word) : "••••••••"}</span></li>`,
      )
      .join("");
    return `
  <section aria-label="Settings">
    <h2>Settings</h2>
    <div class="card">
      <h3>Back up your recovery phrase</h3>
      <p class="warning" role="alert"><strong>Write these ${state.identityCreation.recoveryPhrase.length} words down now.</strong>
      If you lose both your password AND this phrase, your identity is permanently unrecoverable.
      This is the only time they are shown. They are never stored on disk and cannot be recovered if lost.
      Never share them with anyone.</p>
      <ol class="phrase">${words}</ol>
      <div class="phrase-actions">
        <button type="button" data-action="reveal-phrase" class="btn-copy">${revealed ? "Hide phrase" : "Reveal phrase"}</button>
        <button type="button" data-action="copy-phrase" class="btn-copy">Copy phrase</button>
      </div>
      <p class="muted">Public key: ${esc(truncateId(state.identityCreation.publicKey, 20))}</p>
      <div class="row"><button type="button" data-action="creation-dismiss">I have backed it up</button></div>
    </div>
  </section>`;
  }

  const statusLine = state.identity.configured
    ? state.identity.unlocked
      ? "Configured · <strong>Unlocked</strong>"
      : "Configured · <strong>Locked</strong>"
    : "<strong>Not configured</strong>";
  const publicKeyLine = state.identity.publicKey
    ? `<p class="muted">Public key: ${esc(truncateId(state.identity.publicKey, 20))}</p>`
    : "";
  const form = !state.identity.configured
    ? `<form id="identity-create-form" autocomplete="off">
        <h3>Create identity (first run)</h3>
        <div class="form-row"><label>Password
          <div class="input-wrap"><input id="create-password" name="password" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="create-password" class="btn-reveal">Show</button></div>
        </label></div>
        <div class="form-row"><label>Confirm password
          <div class="input-wrap"><input id="create-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="create-confirm" class="btn-reveal">Show</button></div>
        </label></div>
        <div class="row"><button type="submit">Create identity</button></div>
      </form>`
    : !state.identity.unlocked
      ? `<form id="identity-unlock-form" autocomplete="off">
          <h3>Unlock keystore</h3>
          <div class="form-row"><label>Password
            <div class="input-wrap"><input id="unlock-password" name="password" type="password" autocomplete="current-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="unlock-password" class="btn-reveal">Show</button></div>
          </label></div>
          <div class="row"><button type="submit">Unlock</button></div>
        </form>`
      : `<div class="row"><button type="button" data-action="identity-lock">Lock identity</button></div>`;
  const wordInputs = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return `<div class="form-row phrase-input"><label>${n}
      <div class="input-wrap"><input id="recovery-word-${n}" name="word${n}" type="password" autocomplete="off" required minlength="1" placeholder="word ${n}" data-word-input="${n}" /><button type="button" data-action="toggle-word-reveal" data-word-slot="${n}" class="btn-reveal">Show</button></div>
    </label></div>`;
  }).join("");
  const recoveryForm = `<form id="identity-recover-form" autocomplete="off">
        <h3>Recover from phrase</h3>
        <p class="muted">Enter your 12-word recovery phrase. You can paste all words at once into any field.</p>
        <div id="phrase-validation-error" class="validation-error" hidden></div>
        <div class="phrase-inputs">${wordInputs}</div>
        <div class="form-row"><label>New password
          <div class="input-wrap"><input id="recover-password" name="password" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="recover-password" class="btn-reveal">Show</button></div>
        </label></div>
        <div class="form-row"><label>Confirm password
          <div class="input-wrap"><input id="recover-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="recover-confirm" class="btn-reveal">Show</button></div>
        </label></div>
        ${state.identity.configured ? `<div class="form-row"><label class="checkbox-label"><input id="recover-confirm-replace" type="checkbox" /> Replace existing keystore</label></div>` : ""}
        <div class="row"><button type="submit">Recover identity</button></div>
      </form>`;
  return `
  <section aria-label="Settings">
    <h2>Settings</h2>
    <div class="card">
      <h3>Local identity</h3>
      <p>Status: ${statusLine}</p>
      <p class="muted">Label: ${esc(state.identity.label)}</p>
      ${publicKeyLine}
      ${form}
      <p class="muted">Passwords are asked only when needed and never stored — not in this page, not in the backend, nowhere.
      If you lose both your password and recovery phrase, your identity is permanently unrecoverable.
      Identity management requires a server started with identity support; otherwise these actions report an error.</p>
    </div>
    <div class="card">
      ${recoveryForm}
    </div>
    <div class="card">
      <h3>Security guarantees</h3>
      <ul>
        <li>Client-side encryption stays in the audited library packages.</li>
        <li>This dashboard renders metadata only — never file contents, private keys, or encryption keys.</li>
        <li>Recovery phrases are shown once during creation, then immediately cleared from memory.</li>
        <li>Passwords are never stored — not in this page, not in the backend, nowhere.</li>
        <li>Downloads verify every piece before reconstructing your file; corrupt data fails closed.</li>
        <li>Deletes are disabled until their backend integration lands.</li>
        <li>If you lose both your password and recovery phrase, your identity is permanently unrecoverable.</li>
      </ul>
    </div>
  </section>`;
}

/** Full app body for the current view (header nav + notice + screen). */
export function renderApp(state: WebState, stats: DashboardStats): string {
  const screen =
    state.view === "files"
      ? renderFiles(state)
      : state.view === "upload"
        ? renderUpload(state)
        : state.view === "nodes"
          ? renderNodes(state)
          : state.view === "settings"
            ? renderSettings(state)
            : renderDashboard(state, stats);
  return `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true">◈</span> OpenStore</div>
    ${navHtml(state.view)}
    ${state.demoMode ? `<span class="demo-badge" title="All data on screen is local mock data">Demo data</span>` : `<span class="live-badge" title="Data served by the OpenStore web backend">Live</span>`}
  </header>
  <main id="view">${noticeHtml(state.notice)}${screen}</main>
  <footer class="footer"><span>OpenStore dashboard — encrypted storage network.</span></footer>`;
}
