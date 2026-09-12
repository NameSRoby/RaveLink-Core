// [TITLE] Module: capabilities/mod-platform/host/mod-host-registry.js
// [TITLE] Purpose: discover and explicitly supervise optional third-party mods
// [TITLE] Functionality Index:
// [TITLE] - read bounded manifests without executing code or creating directories
// [TITLE] - enforce explicit activation and a global active-process ceiling
// [TITLE] - route requests and shutdown only through per-mod supervisors

const fs = require("node:fs");
const path = require("node:path");
const createModProcessSupervisor = require("./mod-process-supervisor");
const createModCapabilityBroker = require("./mod-capability-broker");
const createModBuiltinServices = require("./mod-builtin-services");
const createModResourceMonitor = require("./mod-resource-monitor");
const { negotiateManifestCapabilities } = require("../contracts/capability-negotiation-v1");
const { validateManifestV1 } = require("../contracts/mod-manifest-v1");
const { verifyPackageDirectory } = require("../packages/mod-package-integrity");
const createModApprovalStore = require("../packages/mod-approval-store");

const MANIFEST_NAME = "ravelink.mod.json";
const MAX_MANIFEST_BYTES = 65536;
const MAX_DISCOVERED_DIRECTORIES = 256;

function safeReadManifest(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: "manifest_not_regular_file" };
    if (stat.size > MAX_MANIFEST_BYTES) return { ok: false, error: "manifest_too_large" };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof SyntaxError ? "manifest_invalid_json" : "manifest_read_failed" };
  }
}

module.exports = function createModHostRegistry(options = {}) {
  const modsRoot = path.resolve(String(options.modsRoot || path.join(process.cwd(), "mods")));
  const requestedMax = Number(options.maxActiveMods);
  const maxActiveMods = Number.isInteger(requestedMax)
    ? Math.min(16, Math.max(1, requestedMax))
    : 4;
  const supervisorFactory = typeof options.supervisorFactory === "function"
    ? options.supervisorFactory
    : createModProcessSupervisor;
  const supervisorOptions = options.supervisorOptions && typeof options.supervisorOptions === "object"
    ? options.supervisorOptions
    : {};
  const runtimeRoot = path.resolve(String(options.runtimeRoot || path.join(process.cwd(), "runtime", "mods")));
  const approvalStore = options.approvalStore || createModApprovalStore({
    storePath: path.join(runtimeRoot, "approvals.json"),
    now: options.now
  });
  const broker = options.broker || createModCapabilityBroker(options.brokerOptions);
  const activationAdmission = typeof options.activationAdmission === "function"
    ? options.activationAdmission
    : async row => {
      const verified = await verifyPackageDirectory(row.rootPath, { limits: options.packageLimits });
      if (!verified.ok) return { ok: false, error: "package_integrity_invalid", detail: verified.error };
      const approval = await approvalStore.getStatus(verified.manifest);
      if (!approval.approved) return { ok: false, error: "permission_approval_required", approval };
      return { ok: true, manifest: verified.manifest, approval };
    };
  const catalog = new Map();
  const supervisors = new Map();
  const resourceMonitor = options.resourceMonitor || createModResourceMonitor({
    ...options.resourceMonitorOptions,
    isIdle: modId => Number(typeof options.now === "function" ? options.now() : Date.now()) - broker.getLastActivity(modId) >= 60000,
    onViolation: async modId => { await disable(modId); }
  });
  const builtinServices = options.builtinServices || createModBuiltinServices({
    broker,
    dataRoot: path.join(runtimeRoot, "data"),
    getManifest: modId => catalog.get(modId)?.manifest || null,
    networkTransport: options.networkTransport,
    egressGovernor: options.egressGovernor,
    now: options.now
  });
  let discoveryErrors = [];
  let discoveredAt = 0;

  function publicRow(row) {
    const supervisor = supervisors.get(row.id);
    const status = supervisor?.getStatus?.() || null;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      publisher: row.publisher,
      license: row.license,
      valid: row.valid,
      lifecycle: status?.lifecycle || (row.valid ? "installed-disabled" : "incompatible"),
      enabled: ["enabling", "active", "draining"].includes(status?.lifecycle),
      error: status?.lastError || row.error || "",
      permissions: row.valid ? { ...row.manifest.permissions } : null,
      resources: row.valid ? { ...row.manifest.resources } : null,
      provides: row.valid ? [...row.manifest.provides] : [],
      consumes: row.valid ? [...row.manifest.consumes] : [],
      uiContributions: row.valid && row.manifest.permissions.ui
        ? row.manifest.contributes.panels.map(panel => ({ id: panel.id, title: panel.title }))
        : [],
      resource: resourceMonitor.getStatus(row.id).mods[0] || null
    };
  }

  function list() {
    const mods = [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)).map(publicRow);
    return {
      ok: true,
      hostEnabled: true,
      total: mods.length,
      active: mods.filter(row => row.enabled).length,
      maxActiveMods,
      discoveredAt,
      discoveryErrors: discoveryErrors.map(error => ({ ...error })),
      mods
    };
  }

  function refreshBrokerCatalog() {
    broker.replaceModProviders([...catalog.values()].filter(row => row.valid).map(row => ({
      manifest: row.manifest,
      getStatus: () => supervisors.get(row.id)?.getStatus?.() || { lifecycle: "installed-disabled", ok: true },
      request: (capability, method, payload, requestOptions) => {
        const supervisor = supervisors.get(row.id);
        if (!supervisor) return Promise.resolve({ ok: false, error: { code: "mod_unavailable", message: "Mod is not active", retryable: true } });
        return supervisor.request(capability, method, payload, requestOptions);
      },
      event: (capability, eventName, payload) => supervisors.get(row.id)?.sendEvent?.(capability, eventName, payload) || false
    })));
  }

  function discover() {
    catalog.clear();
    broker.replaceModProviders([]);
    discoveryErrors = [];
    discoveredAt = Date.now();
    if (!fs.existsSync(modsRoot)) return list();
    let rootStat;
    try { rootStat = fs.lstatSync(modsRoot); } catch { return list(); }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      discoveryErrors.push({ code: "mods_root_invalid" });
      return list();
    }
    const directories = fs.readdirSync(modsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_DISCOVERED_DIRECTORIES);
    for (const directory of directories) {
      const rootPath = path.join(modsRoot, directory.name);
      const manifestPath = path.join(rootPath, MANIFEST_NAME);
      if (!fs.existsSync(manifestPath)) continue;
      const read = safeReadManifest(manifestPath);
      if (!read.ok) {
        discoveryErrors.push({ directory: directory.name, code: read.error });
        continue;
      }
      const validation = validateManifestV1(read.value);
      const fallbackId = `invalid.${directory.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 31) || "mod"}`;
      const id = validation.value?.id || String(read.value?.id || fallbackId).slice(0, 64);
      if (catalog.has(id)) {
        discoveryErrors.push({ directory: directory.name, code: "duplicate_mod_id", modId: id });
        continue;
      }
      catalog.set(id, validation.ok
        ? {
          id,
          name: validation.value.name,
          version: validation.value.version,
          publisher: validation.value.publisher,
          license: validation.value.license,
          valid: true,
          error: "",
          manifest: validation.value,
          rootPath
        }
        : {
          id,
          name: String(read.value?.name || id).slice(0, 80),
          version: String(read.value?.version || "").slice(0, 64),
          publisher: String(read.value?.publisher || "").slice(0, 64),
          license: String(read.value?.license || "").slice(0, 80),
          valid: false,
          error: validation.errors[0]?.code || "manifest_invalid",
          manifest: null,
          rootPath
        });
    }
    refreshBrokerCatalog();
    return list();
  }

  function activeSupervisorCount() {
    let count = 0;
    for (const supervisor of supervisors.values()) {
      if (["enabling", "active", "draining"].includes(supervisor.getStatus()?.lifecycle)) count += 1;
    }
    return count;
  }

  async function enable(modId, activationOptions = {}) {
    const id = String(modId || "");
    const row = catalog.get(id);
    if (!row) return { ok: false, error: "mod_not_found", modId: id };
    if (!row.valid) return { ok: false, error: "manifest_invalid", modId: id };
    let supervisor = supervisors.get(id);
    const current = supervisor?.getStatus?.();
    if (["enabling", "active", "draining"].includes(current?.lifecycle)) return current;
    if (current?.lifecycle === "quarantined") return current;
    if (activeSupervisorCount() >= maxActiveMods) return { ok: false, error: "active_mod_limit", modId: id, maxActiveMods };
    const providerRows = (row.manifest.consumes || []).flatMap(capability => broker.providerRows(capability.replace(/\?$/, "")));
    const negotiation = negotiateManifestCapabilities(row.manifest, providerRows);
    if (!negotiation.ok) return { ok: false, error: "dependencies_unavailable", modId: id, negotiation };
    const admission = await activationAdmission(row);
    if (!admission?.ok) return { ok: false, modId: id, error: admission?.error || "activation_admission_failed", detail: admission?.detail || "", approval: admission?.approval || null };
    if (!supervisor) {
      supervisor = supervisorFactory({
        ...supervisorOptions,
        ...activationOptions,
        manifest: admission.manifest || row.manifest,
        modRoot: row.rootPath,
        onBrokerRequest: (capability, method, payload, requestOptions) => broker.callFromMod(
          admission.manifest || row.manifest, capability, method, payload, requestOptions
        ),
        onBrokerEvent: (capability, eventName, payload) => broker.publishFromMod(
          admission.manifest || row.manifest, capability, eventName, payload
        ),
        onExit: () => resourceMonitor.unregister(id)
      });
      supervisors.set(id, supervisor);
    }
    const started = await supervisor.start();
    if (started?.lifecycle === "active" && started.pid > 0) resourceMonitor.register(id, started.pid, admission.manifest || row.manifest);
    return started;
  }

  async function disable(modId) {
    const id = String(modId || "");
    if (!catalog.has(id)) return { ok: false, error: "mod_not_found", modId: id };
    const supervisor = supervisors.get(id);
    if (!supervisor) return { ok: true, modId: id, lifecycle: "installed-disabled" };
    const stopped = await supervisor.stop();
    resourceMonitor.unregister(id);
    return stopped;
  }

  function request(modId, capability, method, payload, requestOptions) {
    const supervisor = supervisors.get(String(modId || ""));
    if (!supervisor) return Promise.resolve({ ok: false, error: { code: "mod_unavailable", message: "Mod is not active", retryable: true } });
    return supervisor.request(capability, method, payload, requestOptions);
  }

  async function readUiContribution(modId, panelId) {
    const row = catalog.get(String(modId || ""));
    if (!row || !row.valid) return { ok: false, error: "mod_not_found" };
    const panel = row.manifest.contributes.panels.find(item => item.id === String(panelId || ""));
    if (!row.manifest.permissions.ui || !panel) return { ok: false, error: "ui_contribution_not_found" };
    const verified = await verifyPackageDirectory(row.rootPath, { limits: options.packageLimits });
    if (!verified.ok) return { ok: false, error: "package_integrity_invalid", detail: verified.error };
    const approval = await approvalStore.getStatus(verified.manifest);
    if (!approval.approved) return { ok: false, error: "permission_approval_required" };
    const file = verified.files.find(item => item.path === panel.entry);
    if (!file || file.bytes > 262144) return { ok: false, error: "ui_contribution_size_limit" };
    const content = await fs.promises.readFile(path.join(row.rootPath, ...panel.entry.split("/")), "utf8");
    return { ok: true, modId: row.id, panel: { id: panel.id, title: panel.title }, content };
  }

  function registerCapabilityContract(descriptor) {
    const result = broker.registerContract(descriptor);
    refreshBrokerCatalog();
    return result;
  }

  function registerHostCapability(descriptor) {
    return broker.registerHostProvider(descriptor);
  }

  function requestCapability(capability, method, payload, requestOptions) {
    return broker.callFromCore(capability, method, payload, requestOptions);
  }

  function publishCapabilityEvent(capability, eventName, payload) {
    return broker.publishFromCore(capability, eventName, payload);
  }

  async function shutdown() {
    await Promise.allSettled([...supervisors.values()].map(supervisor => supervisor.stop()));
    resourceMonitor.shutdown();
    return list();
  }

  return Object.freeze({
    disable, discover, enable, getBrokerStatus: broker.getStatus, getResourceStatus: resourceMonitor.getStatus,
    list, readUiContribution, registerCapabilityContract, registerSecretHandle: builtinServices.registerSecretHandle,
    publishCapabilityEvent, registerHostCapability, request, requestCapability, shutdown
  });
};

module.exports.MAX_DISCOVERED_DIRECTORIES = MAX_DISCOVERED_DIRECTORIES;
module.exports.MAX_MANIFEST_BYTES = MAX_MANIFEST_BYTES;
module.exports.safeReadManifest = safeReadManifest;
