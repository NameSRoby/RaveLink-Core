// [TITLE] Module: capabilities/mod-platform/host/mod-capability-broker.js
// [TITLE] Purpose: authorize, validate, and dispatch isolated capability calls
// [TITLE] Functionality Index:
// [TITLE] - negotiate lifecycle-aware host and mod providers without direct imports
// [TITLE] - enforce declared consumption, schemas, deadlines, and concurrency ceilings
// [TITLE] - retain bounded payload-free audit and counter telemetry

const { parseCapability, resolveCapabilityDisposition } = require("../contracts/capability-negotiation-v1");

const METHOD_RE = /^[a-z][a-zA-Z0-9.:-]{0,79}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;

function failure(code, message, retryable = false) {
  return { ok: false, error: { code, message, retryable } };
}

function passes(validator, payload) {
  if (typeof validator !== "function") return false;
  try {
    const result = validator(payload);
    return result === true || result?.ok === true;
  } catch {
    return false;
  }
}

module.exports = function createModCapabilityBroker(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const globalLimit = Math.min(64, Math.max(1, Number(options.maxGlobalInFlight) || 16));
  const auditLimit = Math.min(1000, Math.max(10, Number(options.auditLimit) || 250));
  const contracts = new Map();
  const hostProviders = new Map();
  let modProviders = new Map();
  let modConsumers = new Map();
  const eventRates = new Map();
  const lastActivity = new Map();
  const inFlightByRequester = new Map();
  const audit = [];
  const counters = { accepted: 0, completed: 0, failed: 0, timedOut: 0 };
  let globalInFlight = 0;

  function record(row) {
    audit.push({ at: Number(now()), ...row });
    if (audit.length > auditLimit) audit.splice(0, audit.length - auditLimit);
  }

  function registerContract(descriptor = {}) {
    const capability = String(descriptor.capability || "");
    if (!parseCapability(capability).ok) throw new Error("invalid_capability_contract");
    if (!descriptor.methods || typeof descriptor.methods !== "object" || Array.isArray(descriptor.methods)) throw new Error("invalid_capability_methods");
    const methods = new Map();
    for (const [name, method] of Object.entries(descriptor.methods)) {
      if (!METHOD_RE.test(name) || typeof method?.validateRequest !== "function" || typeof method?.validateResponse !== "function") {
        throw new Error("invalid_capability_method_contract");
      }
      methods.set(name, Object.freeze({ validateRequest: method.validateRequest, validateResponse: method.validateResponse }));
    }
    const events = new Map();
    for (const [name, event] of Object.entries(descriptor.events || {})) {
      if (!METHOD_RE.test(name) || typeof event?.validatePayload !== "function") throw new Error("invalid_capability_event_contract");
      events.set(name, Object.freeze({ validatePayload: event.validatePayload }));
    }
    if (!methods.size && !events.size) throw new Error("empty_capability_contract");
    contracts.set(capability, { methods, events });
    return { ok: true, capability, methods: [...methods.keys()].sort(), events: [...events.keys()].sort() };
  }

  function registerHostProvider(descriptor = {}) {
    const providerId = String(descriptor.providerId || "");
    const capability = String(descriptor.capability || "");
    if (!PROVIDER_ID_RE.test(providerId) || !contracts.has(capability) || typeof descriptor.invoke !== "function") {
      throw new Error("invalid_host_provider");
    }
    const key = `${providerId}\0${capability}`;
    hostProviders.set(key, {
      providerId,
      capability,
      invoke: descriptor.invoke,
      getStatus: typeof descriptor.getStatus === "function" ? descriptor.getStatus : () => ({ enabled: true, healthy: true })
    });
    return { ok: true, providerId, capability };
  }

  function replaceModProviders(rows = []) {
    const next = new Map();
    const consumers = new Map();
    for (const row of rows) {
      const manifest = row?.manifest;
      if (!manifest || typeof row.request !== "function" || typeof row.getStatus !== "function") continue;
      for (const capability of manifest.provides || []) {
        if (!contracts.has(capability)) continue;
        next.set(`${manifest.id}\0${capability}`, {
          providerId: manifest.id,
          capability,
          manifest,
          invoke: row.request,
          getStatus: row.getStatus
        });
      }
      consumers.set(manifest.id, row);
    }
    modProviders = next;
    modConsumers = consumers;
    return { ok: true, providers: next.size };
  }

  function providerRows(capability) {
    const rows = [];
    for (const provider of [...hostProviders.values(), ...modProviders.values()]) {
      if (provider.capability !== capability) continue;
      let status = {};
      try { status = provider.getStatus() || {}; } catch {}
      const active = status.lifecycle ? status.lifecycle === "active" : status.enabled !== false;
      rows.push({
        capability,
        providerId: provider.providerId,
        enabled: active,
        healthy: active && status.healthy !== false && status.ok !== false
      });
    }
    return rows;
  }

  function findProvider(capability, providerId = "") {
    const disposition = resolveCapabilityDisposition(capability, providerRows(capability));
    if (!providerId) {
      if (disposition.disposition !== "available") return { disposition, provider: null };
      providerId = disposition.providerId;
    }
    const provider = hostProviders.get(`${providerId}\0${capability}`) || modProviders.get(`${providerId}\0${capability}`);
    const selected = providerRows(capability).find(row => row.providerId === providerId);
    if (!provider || !selected) return { disposition: { ...disposition, disposition: "unavailable" }, provider: null };
    if (!selected.enabled) return { disposition: { ...disposition, disposition: "disabled", providerId }, provider: null };
    if (!selected.healthy) return { disposition: { ...disposition, disposition: "unhealthy", providerId }, provider: null };
    return { disposition: { ...disposition, disposition: "available", providerId }, provider };
  }

  function requesterLimit(requester) {
    return Math.min(4, Math.max(1, Number(requester?.manifest?.resources?.inFlightCalls) || 4));
  }

  async function dispatch(requester, capability, method, payload, callOptions = {}) {
    const requesterId = String(requester?.id || "");
    const contract = contracts.get(capability);
    const methodContract = contract?.methods.get(method);
    const consumed = (requester?.manifest?.consumes || []).map(value => value.replace(/\?$/, ""));
    if (requesterId !== "ravelink.core" && !consumed.includes(capability)) return failure("capability_not_declared", "Mod did not declare this consumed capability");
    if (!methodContract) return failure("capability_method_unknown", "Capability or method contract is not registered");
    if (!passes(methodContract.validateRequest, payload)) return failure("request_schema_invalid", "Request payload failed capability validation");
    const selected = findProvider(capability, String(callOptions.providerId || ""));
    if (!selected.provider) return failure(`provider_${selected.disposition.disposition}`, "No eligible capability provider is available", true);
    const requesterInFlight = inFlightByRequester.get(requesterId) || 0;
    if (globalInFlight >= globalLimit || requesterInFlight >= requesterLimit(requester)) return failure("broker_busy", "Capability concurrency limit reached", true);
    const timeoutMs = Math.min(60000, Math.max(10, Number(callOptions.timeoutMs) || 5000));
    const startedAt = Number(now());
    lastActivity.set(requesterId, startedAt);
    lastActivity.set(selected.provider.providerId, startedAt);
    globalInFlight += 1;
    inFlightByRequester.set(requesterId, requesterInFlight + 1);
    counters.accepted += 1;
    record({ requesterId, providerId: selected.provider.providerId, capability, method, outcome: "accepted" });
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          controller.abort(new Error("broker_deadline_exceeded"));
          resolve(failure("broker_timeout", "Capability call exceeded its deadline", true));
        }, timeoutMs);
      });
      const invoked = Promise.resolve(selected.provider.invoke(capability, method, payload, {
        timeoutMs,
        deadlineAt: startedAt + timeoutMs,
        signal: controller.signal,
        requesterId
      })).then(result => result?.ok === false ? result : { ok: true, value: result?.ok === true && "value" in result ? result.value : result });
      const result = await Promise.race([invoked, timeout]);
      if (!result.ok) {
        const rawCode = String(result.error?.code || "provider_failed");
        const code = /^[a-z][a-z0-9_]{0,63}$/.test(rawCode) ? rawCode : "provider_failed";
        const normalizedFailure = failure(
          code,
          String(result.error?.message || "Capability provider failed").replace(/[\r\n]+/g, " ").slice(0, 300),
          result.error?.retryable === true
        );
        if (code === "broker_timeout") counters.timedOut += 1;
        else counters.failed += 1;
        record({ requesterId, providerId: selected.provider.providerId, capability, method, outcome: code });
        return normalizedFailure;
      }
      if (!passes(methodContract.validateResponse, result.value)) {
        counters.failed += 1;
        record({ requesterId, providerId: selected.provider.providerId, capability, method, outcome: "response_schema_invalid" });
        return failure("response_schema_invalid", "Provider response failed capability validation");
      }
      counters.completed += 1;
      lastActivity.set(requesterId, Number(now()));
      lastActivity.set(selected.provider.providerId, Number(now()));
      record({ requesterId, providerId: selected.provider.providerId, capability, method, outcome: "completed" });
      return result;
    } catch {
      counters.failed += 1;
      return failure("provider_failed", "Capability provider failed", true);
    } finally {
      clearTimeout(timer);
      globalInFlight -= 1;
      const remaining = (inFlightByRequester.get(requesterId) || 1) - 1;
      if (remaining > 0) inFlightByRequester.set(requesterId, remaining);
      else inFlightByRequester.delete(requesterId);
    }
  }

  function callFromCore(capability, method, payload, callOptions) {
    return dispatch({ id: "ravelink.core" }, capability, method, payload, callOptions);
  }

  function callFromMod(manifest, capability, method, payload, callOptions) {
    return dispatch({ id: manifest?.id, manifest }, capability, method, payload, callOptions);
  }

  async function publishFromMod(manifest, capability, eventName, payload) {
    const modId = String(manifest?.id || "");
    if (!(manifest?.provides || []).includes(capability)) return failure("event_publish_denied", "Mod does not provide this capability");
    return await publish(modId, capability, eventName, payload);
  }

  async function publishFromCore(capability, eventName, payload) {
    return await publish("ravelink.core", capability, eventName, payload);
  }

  async function publish(publisherId, capability, eventName, payload) {
    const eventContract = contracts.get(capability)?.events.get(eventName);
    if (!eventContract) return failure("capability_event_unknown", "Capability event contract is not registered");
    if (!passes(eventContract.validatePayload, payload)) return failure("event_schema_invalid", "Event payload failed capability validation");
    const at = Number(now());
    lastActivity.set(publisherId, at);
    const rate = eventRates.get(publisherId) || { windowAt: at, count: 0 };
    if (at - rate.windowAt >= 1000) { rate.windowAt = at; rate.count = 0; }
    rate.count += 1;
    eventRates.set(publisherId, rate);
    if (rate.count > 30) return failure("event_rate_exceeded", "Publisher event rate exceeded", true);
    const deliveries = [];
    for (const [modId, row] of modConsumers) {
      const consumes = (row.manifest?.consumes || []).map(value => value.replace(/\?$/, ""));
      if (!consumes.includes(capability) || typeof row.event !== "function") continue;
      let status;
      try { status = row.getStatus(); } catch { continue; }
      if (status?.lifecycle !== "active") continue;
      deliveries.push(Promise.resolve(row.event(capability, eventName, payload)).then(ok => ({ modId, delivered: ok !== false })).catch(() => ({ modId, delivered: false })));
    }
    const results = await Promise.all(deliveries);
    record({ publisherId, capability, method: eventName, outcome: "event", deliveries: results.length });
    return { ok: true, delivered: results.filter(row => row.delivered).length, failed: results.filter(row => !row.delivered).length };
  }

  function getStatus() {
    return {
      ok: true,
      contracts: contracts.size,
      providers: hostProviders.size + modProviders.size,
      globalInFlight,
      counters: { ...counters },
      audit: audit.map(row => ({ ...row }))
    };
  }

  function getLastActivity(modId) {
    return Number(lastActivity.get(String(modId)) || 0);
  }

  return Object.freeze({
    callFromCore, callFromMod, findProvider, getLastActivity, getStatus, providerRows, publishFromCore,
    publishFromMod, registerContract, registerHostProvider, replaceModProviders
  });
};
