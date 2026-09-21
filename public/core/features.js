import { syncFeatureNavigation, openFeaturePage } from './feature-navigation.js';
import { confirmFeatureDrafts } from './feature-drafts.js';
import './feature-events-client.js';
const byId = id => document.getElementById(id);
let state = { features: [] };
let available = { features: [] };
let lifecycleEvents;

function acceptSnapshot(snapshot) {
  if (snapshot.instanceId === state.instanceId && snapshot.revision < state.revision) return;
  state = snapshot;
  render();
}

function connectLifecycle() {
  if (lifecycleEvents) return;
  lifecycleEvents = window.ravelinkFeatureEvents.subscribe({ lifecycle: true }, message => {
    if (message.type === 'error') { notice(message.error, true); return; }
    if (message.type !== 'lifecycle') return;
    try { acceptSnapshot(message.value); } catch { notice('Feature status update failed.', true); }
  });
}

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, character => entities[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || body.ok === false) throw new Error(body.error?.message || body.error || `HTTP ${response.status}`);
  return body;
}

function permissionText(permissions = {}) {
  const values = [];
  if (permissions.storage) values.push("STORAGE");
  if (permissions.process) values.push("PROCESS");
  if (permissions.network?.length) values.push(`NETWORK ${permissions.network.join(", ")}`);
  if (permissions.secrets?.length) values.push(`SECRETS ${permissions.secrets.length}`);
  if (permissions.hardware?.length) values.push(`HARDWARE ${permissions.hardware.join(", ")}`);
  return values.join(" // ") || "NONE";
}

function render() {
  syncFeatureNavigation(state.features);
  byId("featureHostStatus").textContent = `${state.active || 0} ACTIVE // ${state.total || 0} INSTALLED`;
  byId("featureHostStatus").className = `statusLine${state.active > 0 ? " ok" : ""}`;
  const packageState = new Map(available.features.map(row => [row.id, row]));
  byId("featureRows").innerHTML = state.features.length ? state.features.map(row => {
    const active = row.lifecycle === "active";
    const recoverable = row.lifecycle === "crashed" || row.lifecycle === "quarantined";
    const bundled = packageState.get(row.id);
    const pages = (row.uiContributions || []).map(page => `<button type="button" data-feature-page="${escapeHtml(row.id)}" data-page-id="${escapeHtml(page.id)}" ${active ? "" : "disabled"}>${escapeHtml(page.title).toUpperCase()}</button>`).join("");
    const update = bundled?.updateAvailable ? `<button type="button" data-feature-update="${escapeHtml(row.id)}">UPDATE TO ${escapeHtml(bundled.version)}</button>` : "";
    const rollback = row.rollbackAvailable ? `<button type="button" data-feature-rollback="${escapeHtml(row.id)}">ROLLBACK</button>` : "";
    const resource = row.resource ? `${Number(row.resource.rssMiB || 0).toFixed(1)} / ${Number(row.resource.limits?.activeRssMiB || 0).toFixed(0)} MiB` : `LIMIT ${Number(row.resources?.activeRssMiB || 0).toFixed(0)} MiB`;
    const lifecycleAction = recoverable
      ? `<button type="button" data-feature-restart="${escapeHtml(row.id)}">RESTART</button>`
      : `<button type="button" data-feature-toggle="${escapeHtml(row.id)}" data-enable="${active ? "0" : "1"}">${active ? "DISABLE" : "ENABLE"}</button>`;
    return `<tr><td><div class="modIdentity"><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.id)} // ${escapeHtml(row.version)}</span></div></td><td>${escapeHtml(row.lifecycle).toUpperCase()}<br><span class="muted">STARTUP ${row.enabledOnStartup ? "ON" : "OFF"}</span></td><td class="permissionList">${escapeHtml(permissionText(row.permissions))}</td><td class="resourceCell">${escapeHtml(resource)}</td><td><div class="modActions">${lifecycleAction}${pages}${update}${rollback}<button class="danger" type="button" data-feature-remove="${escapeHtml(row.id)}">UNINSTALL</button></div></td></tr>`;
  }).join("") : '<tr><td colspan="5">NO FEATURES INSTALLED</td></tr>';
  const installedIds = new Set(state.features.map(row => row.id));
  const installable = available.features.filter(row => !installedIds.has(row.id));
  byId("availableFeatureRows").innerHTML = installable.length ? installable.map(row => `<tr><td><div class="modIdentity"><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.description || row.id)}</span></div></td><td>${escapeHtml(row.version)}</td><td class="resourceCell">LIMIT ${Number(row.resources?.activeRssMiB || 0).toFixed(0)} MiB<br><span>${row.downloadRequired ? "DOWNLOAD FROM GITHUB" : `${Math.ceil(Number(row.bytes || 0) / 1024)} KiB PACKAGE`}</span></td><td><button type="button" data-feature-install="${escapeHtml(row.id)}" data-feature-download="${row.downloadRequired ? "1" : "0"}">${row.downloadRequired ? "DOWNLOAD & INSTALL" : "INSTALL"}</button></td></tr>`).join("") : '<tr><td colspan="4">NO PACKAGES AVAILABLE</td></tr>';
}

async function refresh() {
  const [snapshot, packages] = await Promise.all([api("/api/features"), api("/api/features-available")]);
  available = packages;
  acceptSnapshot(snapshot);
  if (packages.warnings?.length) notice("Some downloadable features could not be checked. Confirm internet access and try Refresh.", true);
}

function notice(message, bad = false) {
  byId("featureNotice").textContent = message;
  byId("featureNotice").className = `notice${bad ? " bad" : ""}`;
}

export async function initFeaturePlatform() {
  byId("refreshFeatures").onclick = () => refresh().catch(error => notice(error.message, true));
  byId("featureRows").onclick = async event => {
    const page = event.target.closest("[data-feature-page]");
    if (page) {
      openFeaturePage(page.dataset.featurePage, page.dataset.pageId);
      return;
    }
    const update = event.target.closest("[data-feature-update]");
    if (update) {
      if (!confirmFeatureDrafts(update.dataset.featureUpdate)) return;
      if (!confirm(`Update ${update.dataset.featureUpdate}? Its current version will be retained for rollback.`)) return;
      try {
        await api(`/api/features/${encodeURIComponent(update.dataset.featureUpdate)}/update`, { method: "POST", body: "{}" });
        notice(`${update.dataset.featureUpdate} updated.`);
        await refresh();
      } catch (error) { notice(error.message, true); }
      return;
    }
    const rollback = event.target.closest("[data-feature-rollback]");
    if (rollback) {
      if (!confirmFeatureDrafts(rollback.dataset.featureRollback)) return;
      if (!confirm(`Roll back ${rollback.dataset.featureRollback} to its retained version?`)) return;
      try {
        await api(`/api/features/${encodeURIComponent(rollback.dataset.featureRollback)}/rollback`, { method: "POST", body: "{}" });
        notice(`${rollback.dataset.featureRollback} rolled back.`);
        await refresh();
      } catch (error) { notice(error.message, true); }
      return;
    }
    const restart = event.target.closest("[data-feature-restart]");
    if (restart) {
      if (!confirmFeatureDrafts(restart.dataset.featureRestart)) return;
      try {
        await api(`/api/features/${encodeURIComponent(restart.dataset.featureRestart)}/restart`, { method: "POST", body: "{}" });
        notice(`${restart.dataset.featureRestart} restarted.`);
        await refresh();
      } catch (error) { notice(error.message, true); }
      return;
    }
    const remove = event.target.closest("[data-feature-remove]");
    if (remove) {
      if (!confirmFeatureDrafts(remove.dataset.featureRemove)) return;
      if (!confirm(`Uninstall ${remove.dataset.featureRemove}? Feature data will be retained.`)) return;
      try {
        await api(`/api/features/${encodeURIComponent(remove.dataset.featureRemove)}`, { method: "DELETE" });
        notice(`${remove.dataset.featureRemove} uninstalled; data retained.`);
        await refresh();
      } catch (error) { notice(error.message, true); }
      return;
    }
    const toggle = event.target.closest("[data-feature-toggle]");
    if (!toggle) return;
    if (toggle.dataset.enable === '0' && !confirmFeatureDrafts(toggle.dataset.featureToggle)) return;
    try {
      const operation = toggle.dataset.enable === "1" ? "enable" : "disable";
      await api(`/api/features/${encodeURIComponent(toggle.dataset.featureToggle)}/${operation}`, { method: "POST", body: "{}" });
      notice(`${toggle.dataset.featureToggle} ${operation}d.`);
      await refresh();
    } catch (error) { notice(error.message, true); }
  };
  byId("availableFeatureRows").onclick = async event => {
    const install = event.target.closest("[data-feature-install]");
    if (!install) return;
    if (install.dataset.featureDownload === "1" && !confirm(`Download and install ${install.dataset.featureInstall} from the official RaveLink GitHub repository? The package will be verified before it is activated.`)) return;
    try {
      install.disabled = true;
      await api(`/api/features/${encodeURIComponent(install.dataset.featureInstall)}/install`, { method: "POST", body: "{}" });
      notice(`${install.dataset.featureInstall} installed and enabled.`);
      await refresh();
    } catch (error) { notice(error.message, true); }
  };
  await refresh();
  connectLifecycle();
  window.addEventListener('pagehide', () => { lifecycleEvents?.(); lifecycleEvents = null; });
  window.addEventListener('pageshow', connectLifecycle);
}
