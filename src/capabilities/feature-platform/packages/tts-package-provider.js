function providerError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

module.exports = function createTtsPackageProvider(registry, sources = [], payloadManager = null) {
  const allowed = new Set(sources.map(row => row.id).filter(id => /^tts-[a-z0-9-]{1,58}$/.test(id)));
  const operations = new Map();
  let activeOperation = null;

  const project = row => ({
    id: String(row.id), name: String(row.name || row.id).slice(0, 80), version: String(row.version || "").slice(0, 40),
    description: String(row.description || "").slice(0, 500), installed: row.installed === true,
    installedVersion: String(row.installedVersion || "").slice(0, 40), updateAvailable: row.updateAvailable === true,
    bytes: Math.max(0, Math.min(2147483648, Math.round(Number(row.bytes) || 0))), source: "github", downloadRequired: true,
    operation: operations.get(String(row.id))?.state || "idle",
    operationCode: String(operations.get(String(row.id))?.code || "").slice(0, 80)
  });

  function admit(payload) {
    const id = String(payload?.featureId || "");
    if (allowed.has(id)) return { id, kind: "feature" };
    if (/^tts-(?:runtime|voice)-[a-z0-9-]{1,52}$/.test(id) && payloadManager) return { id, kind: "payload" };
    throw providerError("tts_package_not_allowed", "The requested TTS package is not in the official RaveLink catalog");
  }

  function ttsEngineIsActive() {
    return registry.list().features.some(row => row.id === "tts-engine-local" && row.lifecycle === "active");
  }

  async function runPackageMutation(admitted, action, payload = {}) {
    const featureId = admitted.id;
    if (admitted.kind === "payload") return action === "remove"
      ? payloadManager.remove(featureId)
      : payloadManager.install(featureId);
    if (action === "install") return registry.install(featureId);
    if (action === "update") return registry.update(featureId);
    return registry.uninstall(featureId, { deleteData: payload?.deleteData === true });
  }

  async function mutate(admitted, action, payload = {}) {
    const featureId = admitted.id;
    let resumeEngine = false;
    try {
      if (admitted.kind === "payload" && ttsEngineIsActive()) {
        const stopped = await registry.disable("tts-engine-local", { persist: false, reason: "tts-payload-change" });
        if (stopped?.ok === false) throw providerError("tts_runtime_stop_failed", "The local speech engine could not be stopped safely");
        resumeEngine = true;
      }
      const result = await runPackageMutation(admitted, action, payload);
      if (result?.ok !== true) throw providerError(String(result?.error || `tts_package_${action}_failed`).slice(0, 80), "The TTS package operation failed");
      if (resumeEngine) {
        const restarted = await registry.enable("tts-engine-local", { persist: false, reason: "tts-payload-changed" });
        if (restarted?.lifecycle !== "active") throw providerError("tts_runtime_restart_failed", "The local speech engine could not be restarted");
        resumeEngine = false;
      }
      const suffix = action === "remove" ? "removed" : action === "update" ? "updated" : "installed";
      operations.set(featureId, { state: "succeeded", code: `tts_package_${suffix}` });
    } catch (error) {
      operations.set(featureId, { state: "failed", code: String(error?.code || error?.message || `tts_package_${action}_failed`).slice(0, 80) });
    } finally {
      if (resumeEngine) {
        try { await registry.enable("tts-engine-local", { persist: false, reason: "tts-payload-change-failed" }); } catch {}
      }
      activeOperation = null;
    }
  }

  function start(payload, action) {
    const admitted = admit(payload), featureId = admitted.id;
    if (activeOperation) return { ok: false, featureId, code: "tts_package_busy" };
    activeOperation = { featureId, action };
    operations.set(featureId, { state: "running", code: `tts_package_${action}_started` });
    void Promise.resolve().then(() => mutate(admitted, action, payload)).catch(() => {
      operations.set(featureId, { state: "failed", code: `tts_package_${action}_failed` });
      activeOperation = null;
    });
    return { ok: true, featureId, code: `tts_package_${action}_started` };
  }

  return Object.freeze({
    async status() {
      const result = await registry.listAvailable();
      const payloads = payloadManager ? await payloadManager.status() : { packages: [] };
      const featureRows = (result.features || []).filter(row => allowed.has(row.id)).map(project);
      const payloadRows = (payloads.packages || []).map(project);
      return { ok: true, packages: [...featureRows, ...payloadRows].slice(0, 16), warnings: (result.warnings || []).filter(row => allowed.has(row.featureId)).length };
    },
    install(payload) { return start(payload, "install"); },
    update(payload) { return start(payload, "update"); },
    remove(payload) { return start(payload, "remove"); }
  });
};
