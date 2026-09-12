// [TITLE] Module: capabilities/mod-platform/host/mod-secret-service.js
// [TITLE] Purpose: broker approved credential operations without returning secret values
// [TITLE] Functionality Index:
// [TITLE] - authorize opaque handles from each mod manifest
// [TITLE] - expose only trusted pre-registered operations
// [TITLE] - retain bounded payload-free redacted audit metadata

const HANDLE_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const OPERATION_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const FORBIDDEN_OPERATIONS = /(?:^|[.-])(?:get|read|raw|reveal|export|dump|value|token|secret)(?:$|[.-])/;

module.exports = function createModSecretService(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const auditLimit = Math.min(500, Math.max(10, Number(options.auditLimit) || 100));
  const handles = new Map();
  const audit = [];

  function record(row) {
    audit.push({ at: Number(now()), ...row });
    if (audit.length > auditLimit) audit.splice(0, audit.length - auditLimit);
  }

  function register(descriptor = {}) {
    const handle = String(descriptor.handle || "");
    if (!HANDLE_RE.test(handle) || !descriptor.operations || typeof descriptor.operations !== "object" || Array.isArray(descriptor.operations)) {
      throw new Error("invalid_secret_handle");
    }
    const operations = new Map();
    for (const [name, operation] of Object.entries(descriptor.operations)) {
      if (!OPERATION_RE.test(name) || FORBIDDEN_OPERATIONS.test(name)
        || typeof operation?.perform !== "function" || typeof operation?.validateResult !== "function") {
        throw new Error("invalid_secret_operation");
      }
      operations.set(name, operation);
    }
    if (!operations.size) throw new Error("empty_secret_operations");
    handles.set(handle, { operations, available: typeof descriptor.available === "function" ? descriptor.available : () => true });
    return { ok: true, handle, operations: [...operations.keys()].sort() };
  }

  async function invoke(manifest, handleInput, operationInput, payload, context = {}) {
    const modId = String(manifest?.id || "");
    const handle = String(handleInput || "");
    const operation = String(operationInput || "");
    if (!(manifest?.permissions?.secrets || []).includes(handle)) {
      record({ modId, handle, operation, outcome: "permission_denied" });
      return { ok: false, error: "secret_permission_denied" };
    }
    const registered = handles.get(handle);
    if (!registered) return { ok: false, error: "secret_handle_unavailable" };
    const operationContract = registered.operations.get(operation);
    if (!operationContract) return { ok: false, error: "secret_operation_denied" };
    let available = false;
    try { available = registered.available() === true; } catch {}
    if (!available) return { ok: false, error: "secret_not_configured" };
    try {
      const result = await operationContract.perform(payload, {
        modId,
        signal: context.signal,
        deadlineAt: context.deadlineAt
      });
      if (operationContract.validateResult(result) !== true) {
        record({ modId, handle, operation, outcome: "response_rejected" });
        return { ok: false, error: "secret_response_rejected" };
      }
      record({ modId, handle, operation, outcome: "completed" });
      return { ok: true, result: result === undefined ? null : result };
    } catch {
      record({ modId, handle, operation, outcome: "failed" });
      return { ok: false, error: "secret_operation_failed" };
    }
  }

  function getStatus(manifest) {
    const approved = new Set(manifest?.permissions?.secrets || []);
    const available = [];
    for (const [handle, descriptor] of handles) {
      if (!approved.has(handle)) continue;
      let configured = false;
      try { configured = descriptor.available() === true; } catch {}
      available.push({ handle, configured, operations: [...descriptor.operations.keys()].sort() });
    }
    return { ok: true, handles: available.sort((a, b) => a.handle.localeCompare(b.handle)), audit: audit.map(row => ({ ...row })) };
  }

  return Object.freeze({ getStatus, invoke, register });
};
