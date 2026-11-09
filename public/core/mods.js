/**
 * Mods.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
import { initModUiRelay } from "./mod-ui-relay.js";
const byId = (id) => document.getElementById(id);
let state = null;
let eventSource = null;
let panelRelay;

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
}

function permissionSummary(mod) {
  const permissions = mod.permissions || {};
  const rows = [];
  if (permissions.network?.length) rows.push(`Network: ${permissions.network.join(", ")}`);
  if (permissions.storage) rows.push("Local storage");
  if (permissions.secrets?.length) rows.push(`Secret handles: ${permissions.secrets.join(", ")}`);
  if (permissions.ui) rows.push("Operator UI");
  if (permissions.process) rows.push("Child process");
  if (permissions.hardware?.length) rows.push(`Hardware: ${permissions.hardware.join(", ")}`);
  if ((mod.consumes || []).includes("ravelink.controls.v1"))
    rows.push(
      "Full app controls: keyboard/app launch, audio, playback, OBS, lights and Twitch actions",
    );
  return rows.length ? rows.join(" | ") : "No privileged permissions";
}

function resourceSummary(mod) {
  const resources = mod.resources || {};
  return `RSS ${resources.activeRssMiB ?? "-"} MiB | CPU ${resources.idleCpuPercent ?? "-"}% | ${resources.inFlightCalls ?? "-"} calls`;
}

function renderInbox() {
  const inbox = state?.inbox || { candidates: [], total: 0, inbox: "mods" };
  byId("modInboxStatus").textContent = `${inbox.inbox}\\ // ${inbox.total} DETECTED`;
  byId("modInboxRows").innerHTML = inbox.candidates.length
    ? inbox.candidates
        .map((candidate) => {
          const status = candidate.installed
            ? '<span class="statusLine">INSTALLED</span>'
            : candidate.valid
              ? `<button data-inbox-accept="${candidate.candidateId}">${candidate.active ? "Review update" : "Activate"}</button>`
              : `<span class="invalid">${escapeHtml(candidate.error)}</span>`;
          return `<tr><td class="modIdentity"><strong>${escapeHtml(candidate.name)}</strong><span>${escapeHtml(candidate.sourceName)} ${escapeHtml(candidate.version)}</span></td><td>${escapeHtml(candidate.kind).toUpperCase()}</td><td class="permissionList">${escapeHtml(permissionSummary(candidate))}</td><td>${escapeHtml(resourceSummary(candidate))}</td><td>${status}</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="5">Drop a mod folder or ZIP into mods. It will appear here automatically.</td></tr>';
}

function renderInstalled() {
  const rows = state?.mods || [];
  byId("modHostStatus").textContent = `${state.active}/${state.maxActiveMods} ACTIVE`;
  byId("modRows").innerHTML = rows.length
    ? rows
        .map((mod) => {
          const approval = mod.approval || {};
          const resource = mod.resource || {};
          const approved = approval.approved === true;
          const active = mod.enabled === true;
          const actions = [
            ...(mod.uiContributions || []).map(
              (panel) =>
                `<button data-action="open-ui" data-id="${escapeHtml(mod.id)}" data-panel="${escapeHtml(panel.id)}" ${!approved ? "disabled" : ""}>${escapeHtml(panel.title)}</button>`,
            ),
            approval.needsApproval
              ? `<button data-action="approve" data-id="${escapeHtml(mod.id)}">APPROVE</button>`
              : "",
            active
              ? `<button data-action="disable" data-id="${escapeHtml(mod.id)}">DISABLE</button>`
              : `<button data-action="enable" data-id="${escapeHtml(mod.id)}" ${!approved || !mod.valid ? "disabled" : ""}>ENABLE</button>`,
            `<button data-action="rollback" data-id="${escapeHtml(mod.id)}" ${active || !mod.rollbackAvailable ? "disabled" : ""}>ROLLBACK</button>`,
            `<button class="danger" data-action="uninstall" data-id="${escapeHtml(mod.id)}" ${active ? "disabled" : ""}>UNINSTALL</button>`,
          ].join("");
          return `<tr><td class="modIdentity"><strong>${escapeHtml(mod.name)}</strong><span>${escapeHtml(mod.id)} ${escapeHtml(mod.version)}</span></td><td>${escapeHtml(mod.lifecycle)}${mod.error ? `<br><span class="notice bad">${escapeHtml(mod.error)}</span>` : ""}</td><td class="permissionList"><strong>${approved ? "APPROVED" : "REVIEW REQUIRED"}</strong><br>${escapeHtml(permissionSummary(mod))}</td><td class="resourceCell"><span>RSS ${escapeHtml(resource.rssMiB ?? "-")} MiB</span><span>CPU ${escapeHtml(resource.cpuPercent ?? "-")}%</span></td><td><div class="modActions">${actions}</div></td></tr>`;
        })
        .join("")
    : '<tr><td colspan="5">NO MODS INSTALLED</td></tr>';
}

function render() {
  renderInbox();
  renderInstalled();
}

function notice(message, bad = false) {
  byId("modNotice").textContent = message;
  byId("modNotice").classList.toggle("bad", bad);
}

async function refresh() {
  state = await api("/api/mod-platform");
  render();
}

async function acceptCandidate(candidateId) {
  const candidate = state.inbox.candidates.find((row) => row.candidateId === candidateId);
  if (!candidate?.valid) return;
  const review = `${candidate.name} ${candidate.version}\n\n${permissionSummary(candidate)}\n${resourceSummary(candidate)}\n\nActivate this mod? Its declared API access will be approved and its buttons and UI made available.\n\nOnly activate code you trust: Windows Node cannot fully block undeclared network access; activation accepts reduced OS isolation for this execution.`;
  if (!window.confirm(review)) return;
  if (candidate.active)
    await api(`/api/mod-platform/${encodeURIComponent(candidate.id)}/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  notice(`${candidate.name}: VERIFYING, INSTALLING, AND STARTING`);
  const result = await api(`/api/mod-platform/inbox/${candidate.candidateId}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fingerprint: candidate.fingerprint,
      packageFingerprint: candidate.packageFingerprint,
      replace: Boolean(state.mods.some((row) => row.id === candidate.id)),
      allowUnsafeRuntime: true,
    }),
  });
  state = result.host;
  render();
  notice(`${candidate.name}: ACTIVE`);
}

async function act(action, modId, panelId = "") {
  const mod = state.mods.find((row) => row.id === modId);
  if (!mod) return;
  if (action === "open-ui") {
    const panel = mod.uiContributions.find((item) => item.id === panelId);
    if (!panel) return;
    byId("modUiTitle").textContent = `${mod.name}: ${panel.title}`;
    panelRelay.open(modId, panelId);
    byId("modUiSurface").hidden = false;
    byId("modUiSurface").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  let method = "POST";
  let body = "{}";
  if (action === "approve") {
    if (!window.confirm(`Approve ${mod.name} ${mod.version}?\n\n${permissionSummary(mod)}`)) return;
    body = JSON.stringify({ fingerprint: mod.approval.fingerprint });
  }
  if (action === "enable") {
    if (
      !window.confirm(
        `Activate ${mod.name}?\n\n${permissionSummary(mod)}\n\nOnly activate code you trust. Windows Node cannot fully block undeclared network access; activation accepts reduced OS isolation for this execution.`,
      )
    )
      return;
    body = JSON.stringify({ allowUnsafeRuntime: true });
  }
  if (action === "uninstall") {
    if (!window.confirm(`Uninstall ${mod.name}? Mod data will be retained.`)) return;
    method = "DELETE";
    body = JSON.stringify({ deleteData: false });
  }
  notice(`${action.toUpperCase()} IN PROGRESS`);
  const suffix = action === "uninstall" ? "" : `/${action}`;
  await api(`/api/mod-platform/${encodeURIComponent(modId)}${suffix}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
  await refresh();
  notice(`${mod.name}: ${action.toUpperCase()} COMPLETE`);
}

export function initModPlatform() {
  const refreshButton = byId("refreshMods");
  if (!refreshButton || refreshButton.dataset.ready === "1") return;
  refreshButton.dataset.ready = "1";
  panelRelay = initModUiRelay(byId("modUiFrame"));
  refreshButton.addEventListener("click", async () => {
    try {
      state = await api("/api/mod-platform/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      render();
      notice("DISCOVERY COMPLETE");
    } catch (error) {
      notice(error.message, true);
    }
  });
  byId("modInboxRows").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-inbox-accept]");
    if (!button) return;
    button.disabled = true;
    try {
      await acceptCandidate(button.dataset.inboxAccept);
    } catch (error) {
      notice(error.message, true);
      await refresh().catch(() => {});
    }
  });
  byId("modRows").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await act(button.dataset.action, button.dataset.id, button.dataset.panel);
    } catch (error) {
      notice(error.message, true);
      await refresh().catch(() => {});
    }
  });
  byId("closeModUi").addEventListener("click", () => {
    panelRelay.close();
    byId("modUiSurface").hidden = true;
  });
  eventSource = new EventSource("/api/mod-platform/events");
  eventSource.addEventListener("inbox", () =>
    refresh().catch((error) => notice(error.message, true)),
  );
  window.addEventListener("beforeunload", () => eventSource?.close(), {
    once: true,
  });
  refresh().catch((error) => notice(error.message, true));
}
