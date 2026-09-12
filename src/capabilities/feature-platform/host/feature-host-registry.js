const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const createFeatureProcessSupervisor = require("./feature-process-supervisor");
const { verifyFeaturePackageDirectory } = require("../packages/feature-package-integrity");
const { compileFeatureContracts } = require("../contracts/data-contract-compiler");
const createQuotaJsonStorage = require("../../../shared/storage/quota-json-storage");
const createResourceMonitor = require("../../supervised-runtime/host/resource-monitor");
const createFeatureStateStore = require("../packages/feature-state-store");
const createFeaturePackageManager = require("../packages/feature-package-manager");

const MAX_INSTALLED_FEATURES = 16;

module.exports = function createFeatureHostRegistry(options = {}) {
  const featuresRoot = path.resolve(options.featuresRoot || path.join(process.cwd(), "features", "installed"));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(process.cwd(), "runtime", "features"));
  const supervisorFactory = options.supervisorFactory || createFeatureProcessSupervisor;
  const providers = new Map(Object.entries(options.providers || {}));
  const storage = createQuotaJsonStorage({ dataRoot: path.join(runtimeRoot, "data"), identityPattern: /^[a-z][a-z0-9-]{1,63}$/ });
  const stateStore = options.stateStore || createFeatureStateStore({ storePath: path.join(runtimeRoot, "state.json"), now: options.now });
  const packageManager = options.packageManager || createFeaturePackageManager({
    installedRoot: featuresRoot,
    packageRoots: options.packageRoots || [],
    runtimeRoot,
    packageLimits: options.packageLimits
  });
  const catalog = new Map();
  const supervisors = new Map();
  const lastActivity = new Map();
  const eventSubscribers = new Map();
  const lifecycleSubscribers = new Set();
  const streamSubscribers = new Set();
  const instanceId = crypto.randomUUID();
  let revision = 0;

  function notifyLifecycle() {
    revision += 1;
    if (!lifecycleSubscribers.size && !streamSubscribers.size) return;
    const snapshot = list();
    for (const listener of lifecycleSubscribers) {
      try { listener(snapshot); } catch {}
    }
    for (const listener of streamSubscribers) {
      try { listener('lifecycle', snapshot); } catch {}
    }
  }

  function subscribeLifecycle(listener) {
    if (typeof listener !== 'function' || lifecycleSubscribers.size >= 16) return null;
    lifecycleSubscribers.add(listener);
    return () => lifecycleSubscribers.delete(listener);
  }
  function subscribeStream(listener) {
    if (typeof listener !== 'function' || streamSubscribers.size >= 16) return null;
    streamSubscribers.add(listener);
    return () => streamSubscribers.delete(listener);
  }
  const resourceMonitor = options.resourceMonitor || createResourceMonitor({
    ...options.resourceMonitorOptions,
    identityField: "featureId",
    collectionName: "features",
    isIdle: featureId => Number(typeof options.now === "function" ? options.now() : Date.now()) - Number(lastActivity.get(featureId) || 0) >= 60000,
    onViolation: async (featureId, violation) => { await disable(featureId, { reason: violation.code }); }
  });
  let discoveryErrors = [];

  function rowStatus(row) {
    const status = supervisors.get(row.id)?.getStatus() || null;
    const desired = stateStore.get(row.id);
    return {
      id: row.id,
      name: row.manifest.name,
      version: row.manifest.version,
      lifecycle: status?.lifecycle || "installed-disabled",
      pid: status?.pid || 0,
      error: status?.lastError || "",
      enabledOnStartup: desired.enabled,
      stateReason: desired.reason,
      rollbackAvailable: packageManager.hasRollback(row.id),
      provides: [...row.manifest.provides],
      consumes: [...row.manifest.consumes],
      permissions: {
        network: [...row.manifest.permissions.network], storage: row.manifest.permissions.storage,
        secrets: [...row.manifest.permissions.secrets], process: row.manifest.permissions.process,
        hardware: [...row.manifest.permissions.hardware]
      },
      resources: { ...row.manifest.resources },
      uiContributions: row.manifest.contributes.pages.map(page => ({ id: page.id, title: page.title, surface: page.surface, capabilities: [...page.capabilities] })),
      resource: resourceMonitor.getStatus(row.id).features[0] || null
    };
  }

  function list() {
    const features = [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)).map(rowStatus);
    return { ok: true, instanceId, revision, total: features.length, active: features.filter(row => row.lifecycle === "active").length, discoveryErrors: [...discoveryErrors], resources: resourceMonitor.getStatus(), features };
  }

  async function callProvider(manifest, capability, method, payload, callOptions) {
    lastActivity.set(manifest.id, Number(typeof options.now === "function" ? options.now() : Date.now()));
    const declared = manifest.consumes.map(value => value.replace(/\?$/, ""));
    if (!declared.includes(capability)) return { ok: false, error: { code: "capability_not_declared", message: "Feature did not declare this capability", retryable: false } };
    if (capability === "ravelink.storage.v1" && ["get", "set", "remove", "status"].includes(method)) {
      const storagePayload = payload && typeof payload === "object" ? payload : {};
      const value = method === "set"
        ? await storage.set(manifest, storagePayload.key, storagePayload.value)
        : method === "get"
          ? await storage.get(manifest, storagePayload.key)
          : method === "remove"
            ? await storage.remove(manifest, storagePayload.key)
            : await storage.status(manifest);
      return { ok: true, value };
    }
    const provider = providers.get(`${capability}/${method}`);
    if (typeof provider !== "function") {
      const candidates = [...catalog.values()].filter(row => row.id !== manifest.id
        && row.manifest.provides.includes(capability)
        && row.contracts.get(capability)?.methods.has(method)
        && supervisors.get(row.id)?.getStatus()?.lifecycle === "active");
      if (candidates.length !== 1) {
        const code = candidates.length ? "provider_ambiguous" : "provider_unavailable";
        return { ok: false, error: { code, message: candidates.length ? "Multiple active features provide this capability" : "Capability provider is unavailable", retryable: candidates.length === 0 } };
      }
      const currentTime = Number(typeof options.now === "function" ? options.now() : Date.now());
      const deadlineAt = Number(callOptions?.deadlineAt || 0);
      const remainingMs = deadlineAt > currentTime ? deadlineAt - currentTime : 5000;
      return request(candidates[0].id, capability, method, payload, { timeoutMs: Math.min(60000, remainingMs) });
    }
    try {
      const value = await provider(payload, { ...callOptions, featureId: manifest.id });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: String(error?.code || "provider_failed"), message: String(error?.message || "Capability provider failed").slice(0, 300), retryable: error?.retryable === true } };
    }
  }

  function publishFeatureEvent(row, capability, event, payload) {
    const validator = row.contracts.get(String(capability || ""))?.events.get(String(event || ""));
    if (!validator || !validator(payload)) return false;
    lastActivity.set(row.id, Number(typeof options.now === "function" ? options.now() : Date.now()));
    const listeners = eventSubscribers.get(row.id);
    if (!listeners?.size && !streamSubscribers.size) return true;
    const message = Object.freeze({ featureId: row.id, capability, event, payload, observedAt: Number(typeof options.now === "function" ? options.now() : Date.now()) });
    for (const listener of listeners || []) {
      try { listener(message); } catch {}
    }
    for (const listener of streamSubscribers) {
      try { listener('feature', message); } catch {}
    }
    return true;
  }

  function subscribe(featureId, listener) {
    const id = String(featureId || "");
    if (!catalog.has(id) || typeof listener !== "function") return () => {};
    let listeners = eventSubscribers.get(id);
    if (!listeners) {
      listeners = new Set();
      eventSubscribers.set(id, listeners);
    }
    if (listeners.size >= 16) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) eventSubscribers.delete(id);
    };
  }

  async function readUiContribution(featureId, pageId) {
    const row = catalog.get(String(featureId || ""));
    if (!row) return { ok: false, error: "feature_not_found" };
    if (supervisors.get(row.id)?.getStatus()?.lifecycle !== "active") return { ok: false, error: "feature_not_active" };
    const page = row.manifest.contributes.pages.find(item => item.id === String(pageId || ""));
    if (!page) return { ok: false, error: "ui_contribution_not_found" };
    const absolute = path.join(row.rootPath, ...page.entry.split("/"));
    let content;
    try {
      const stat = await fs.promises.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { ok: false, error: "ui_contribution_invalid" };
      content = await fs.promises.readFile(absolute);
    } catch { return { ok: false, error: "ui_contribution_invalid" }; }
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    if (digest !== row.manifest.integrity.files[page.entry]) return { ok: false, error: "ui_contribution_integrity_failed" };
    return { ok: true, content, page };
  }

  async function discover() {
    const discovered = new Map();
    discoveryErrors = [];
    if (!fs.existsSync(featuresRoot)) { catalog.clear(); notifyLifecycle(); return list(); }
    const rootStat = fs.lstatSync(featuresRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ...list(), discoveryErrors: [{ code: "features_root_invalid" }] };
    const directories = fs.readdirSync(featuresRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_INSTALLED_FEATURES);
    for (const directory of directories) {
      const rootPath = path.join(featuresRoot, directory.name);
      const verified = await verifyFeaturePackageDirectory(rootPath, { limits: options.packageLimits });
      if (!verified.ok) {
        discoveryErrors.push({ directory: directory.name, code: verified.error });
        continue;
      }
      const compiled = await compileFeatureContracts(rootPath, verified.manifest);
      if (!compiled.ok) {
        discoveryErrors.push({ directory: directory.name, code: compiled.error, file: compiled.file || "" });
        continue;
      }
      if (discovered.has(verified.manifest.id)) {
        discoveryErrors.push({ directory: directory.name, code: "duplicate_feature_id", featureId: verified.manifest.id });
        continue;
      }
      discovered.set(verified.manifest.id, { id: verified.manifest.id, manifest: verified.manifest, contracts: compiled.contracts, rootPath });
    }
    catalog.clear();
    for (const [id, row] of discovered) catalog.set(id, row);
    notifyLifecycle();
    return list();
  }

  async function enable(featureId, activationOptions = {}) {
    const row = catalog.get(String(featureId || ""));
    if (!row) return { ok: false, error: "feature_not_found", featureId: String(featureId || "") };
    let supervisor = supervisors.get(row.id);
    if (!supervisor) {
      supervisor = supervisorFactory({
        manifest: row.manifest,
        modRoot: row.rootPath,
        storageRoot: path.join(runtimeRoot, "data", row.id),
        allowUnsafeRuntime: options.allowUnsafeRuntime === true,
        onBrokerRequest: (capability, method, payload, callOptions) => callProvider(row.manifest, capability, method, payload, callOptions),
        onBrokerEvent: (capability, event, payload) => publishFeatureEvent(row, capability, event, payload),
        onExit: () => { resourceMonitor.unregister(row.id); notifyLifecycle(); }
      });
      supervisors.set(row.id, supervisor);
    }
    const started = await supervisor.start();
    if (started.lifecycle === "active") {
      lastActivity.set(row.id, Number(typeof options.now === "function" ? options.now() : Date.now()));
      resourceMonitor.register(row.id, started.pid, row.manifest);
      if (activationOptions.persist !== false) stateStore.setEnabled(row.id, true, activationOptions.reason || "operator");
    }
    notifyLifecycle();
    return started;
  }

  async function startInstalled() {
    await discover();
    return Promise.all([...catalog.keys()].filter(id => stateStore.get(id).enabled).map(id => enable(id, { persist: false, reason: "startup" })));
  }

  async function disable(featureId, disableOptions = {}) {
    const id = String(featureId || "");
    if (!catalog.has(id)) return { ok: false, error: "feature_not_found", featureId: id };
    const supervisor = supervisors.get(id);
    if (disableOptions.persist !== false) stateStore.setEnabled(id, false, disableOptions.reason || "operator");
    if (!supervisor) { notifyLifecycle(); return { ok: true, featureId: id, lifecycle: "installed-disabled" }; }
    const stopped = await supervisor.stop();
    resourceMonitor.unregister(id);
    lastActivity.delete(id);
    notifyLifecycle();
    return stopped;
  }

  async function restart(featureId) {
    const id = String(featureId || "");
    if (!catalog.has(id)) return { ok: false, error: "feature_not_found", featureId: id };
    const supervisor = supervisors.get(id);
    const lifecycle = supervisor?.getStatus()?.lifecycle || "installed-disabled";
    if (lifecycle === "active" || lifecycle === "enabling" || lifecycle === "draining") {
      await disable(id, { persist: false, reason: "operator-restart" });
    }
    if (supervisor?.getStatus()?.lifecycle === "quarantined") supervisor.resetQuarantine();
    return enable(id, { persist: true, reason: "operator-restart" });
  }

  async function install(featureId) {
    const installed = await packageManager.install(featureId);
    if (!installed.ok) return installed;
    await discover();
    stateStore.setEnabled(installed.featureId, false, "installed");
    notifyLifecycle();
    const row = catalog.get(installed.featureId);
    return row ? { ok: true, installed: true, feature: rowStatus(row) } : { ok: false, error: "feature_install_discovery_failed" };
  }

  async function uninstall(featureId, uninstallOptions = {}) {
    const id = String(featureId || "");
    if (!catalog.has(id)) return { ok: false, error: "feature_not_found" };
    await disable(id, { persist: true, reason: "uninstalled" });
    const removed = await packageManager.uninstall(id, uninstallOptions);
    if (!removed.ok) return removed;
    supervisors.delete(id);
    await discover();
    return removed;
  }

  async function replaceInstalled(featureId, operation) {
    const id = String(featureId || "");
    const current = catalog.get(id);
    if (!current) return { ok: false, error: "feature_not_found" };
    const packages = await packageManager.listAvailable();
    const packageStatus = packages.features.find(row => row.id === id);
    if (operation === "update" && !packageStatus?.updateAvailable) return { ok: false, error: "feature_update_not_available" };
    if (operation === "rollback" && !packageManager.hasRollback(id)) return { ok: false, error: "feature_rollback_unavailable" };
    const previousLifecycle = supervisors.get(id)?.getStatus()?.lifecycle || "installed-disabled";
    const shouldEnable = stateStore.get(id).enabled;
    await disable(id, { persist: false, reason: operation });
    supervisors.delete(id);
    const changed = await packageManager[operation](id);
    if (!changed.ok) {
      await discover();
      if (previousLifecycle === "active") await enable(id, { persist: false, reason: `${operation}-failed` });
      return changed;
    }
    await discover();
    let activation = null;
    if (shouldEnable) activation = await enable(id, { persist: false, reason: operation });
    if (shouldEnable && activation?.lifecycle !== "active") {
      await disable(id, { persist: false, reason: `${operation}-activation-failed` });
      supervisors.delete(id);
      const restored = await packageManager.rollback(id);
      await discover();
      const restart = previousLifecycle === "active" ? await enable(id, { persist: false, reason: `${operation}-restored` }) : null;
      return {
        ok: false,
        error: "feature_activation_after_switch_failed",
        restored: restored.ok === true,
        restartLifecycle: restart?.lifecycle || previousLifecycle,
        detail: String(activation?.lastError || activation?.error || "feature did not become active").slice(0, 160)
      };
    }
    const row = catalog.get(id);
    return { ...changed, feature: row ? rowStatus(row) : null };
  }

  function update(featureId) {
    return replaceInstalled(featureId, "update");
  }

  function rollback(featureId) {
    return replaceInstalled(featureId, "rollback");
  }

  function request(featureId, capability, method, payload, requestOptions) {
    const row = catalog.get(String(featureId || ""));
    const contract = row?.contracts.get(String(capability || ""))?.methods.get(String(method || ""));
    if (!contract) return Promise.resolve({ ok: false, error: { code: "method_unavailable", message: "Feature method is not declared", retryable: false } });
    if (!contract.request(payload)) return Promise.resolve({ ok: false, error: { code: "request_schema_invalid", message: "Request does not match the feature contract", retryable: false } });
    const supervisor = supervisors.get(String(featureId || ""));
    if (!supervisor) return Promise.resolve({ ok: false, error: { code: "feature_unavailable", message: "Feature is not active", retryable: true } });
    lastActivity.set(String(featureId), Number(typeof options.now === "function" ? options.now() : Date.now()));
    return supervisor.request(capability, method, payload, requestOptions).then(result => {
      if (!result.ok || contract.response(result.value)) return result;
      return { ok: false, error: { code: "response_schema_invalid", message: "Feature returned an invalid response", retryable: false } };
    });
  }

  async function shutdown() {
    await Promise.allSettled([...supervisors.values()].map(supervisor => supervisor.stop()));
    resourceMonitor.shutdown();
    lastActivity.clear();
    eventSubscribers.clear();
    for (const listener of lifecycleSubscribers) {
      try { listener(null); } catch {}
    }
    lifecycleSubscribers.clear();
    for (const listener of streamSubscribers) {
      try { listener('close', null); } catch {}
    }
    streamSubscribers.clear();
    return list();
  }

  return Object.freeze({
    disable, discover, enable, install, listAvailable: packageManager.listAvailable, restart, rollback, uninstall, update, getResourceStatus: resourceMonitor.getStatus, list, readUiContribution, request,
    sampleResources: resourceMonitor.sampleOnce, shutdown, startInstalled, subscribe, subscribeLifecycle, subscribeStream
  });
};

module.exports.MAX_INSTALLED_FEATURES = MAX_INSTALLED_FEATURES;
