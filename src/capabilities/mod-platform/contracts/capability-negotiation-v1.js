// [TITLE] Module: capabilities/mod-platform/contracts/capability-negotiation-v1.js
// [TITLE] Purpose: resolve optional mod capability dependencies without direct imports
// [TITLE] Functionality Index:
// [TITLE] - classify exact, missing, disabled, incompatible, unhealthy, and ambiguous providers
// [TITLE] - distinguish required from optional manifest dependencies
// [TITLE] - return deterministic machine-readable activation dispositions

const CAPABILITY_RE = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)\.v([1-9][0-9]*)$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;
const CAPABILITY_DISPOSITIONS = Object.freeze([
  "available", "unavailable", "disabled", "incompatible", "unhealthy", "ambiguous"
]);

function parseCapability(value) {
  const optional = typeof value === "string" && value.endsWith("?");
  const capability = optional ? value.slice(0, -1) : String(value || "");
  const match = capability.match(CAPABILITY_RE);
  return match
    ? { ok: true, capability, base: match[1], major: Number(match[2]), optional }
    : { ok: false, capability, base: "", major: 0, optional };
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers)) return [];
  return providers
    .filter(row => row && typeof row === "object" && !Array.isArray(row))
    .map(row => ({
      capability: String(row.capability || "").trim(),
      providerId: String(row.providerId || "").trim(),
      enabled: row.enabled === true,
      healthy: row.healthy === true
    }))
    .filter(row => parseCapability(row.capability).ok && PROVIDER_ID_RE.test(row.providerId))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function resolveCapabilityDisposition(requested, providers = []) {
  const parsed = parseCapability(requested);
  if (!parsed.ok) {
    return { capability: parsed.capability, optional: parsed.optional, disposition: "incompatible", providerId: "", candidates: [] };
  }
  const rows = normalizeProviders(providers);
  const sameBase = rows.filter(row => parseCapability(row.capability).base === parsed.base);
  const exact = sameBase.filter(row => row.capability === parsed.capability);
  const available = exact.filter(row => row.enabled && row.healthy);
  if (available.length === 1) {
    return { capability: parsed.capability, optional: parsed.optional, disposition: "available", providerId: available[0].providerId, candidates: [available[0].providerId] };
  }
  if (available.length > 1) {
    return { capability: parsed.capability, optional: parsed.optional, disposition: "ambiguous", providerId: "", candidates: available.map(row => row.providerId) };
  }
  const unhealthy = exact.filter(row => row.enabled && !row.healthy);
  if (unhealthy.length) {
    return { capability: parsed.capability, optional: parsed.optional, disposition: "unhealthy", providerId: unhealthy[0].providerId, candidates: unhealthy.map(row => row.providerId) };
  }
  const disabled = exact.filter(row => !row.enabled);
  if (disabled.length) {
    return { capability: parsed.capability, optional: parsed.optional, disposition: "disabled", providerId: disabled[0].providerId, candidates: disabled.map(row => row.providerId) };
  }
  if (sameBase.length) {
    return { capability: parsed.capability, optional: parsed.optional, disposition: "incompatible", providerId: "", candidates: sameBase.map(row => row.providerId) };
  }
  return { capability: parsed.capability, optional: parsed.optional, disposition: "unavailable", providerId: "", candidates: [] };
}

function negotiateManifestCapabilities(manifest, providers = []) {
  const consumes = Array.isArray(manifest?.consumes) ? manifest.consumes : [];
  const dependencies = consumes.map(capability => resolveCapabilityDisposition(capability, providers));
  const blocked = dependencies.filter(row => row.optional !== true && row.disposition !== "available");
  return {
    ok: blocked.length === 0,
    disposition: blocked.length ? "dependencies_unavailable" : "ready",
    dependencies,
    blocked
  };
}

module.exports = {
  CAPABILITY_DISPOSITIONS,
  negotiateManifestCapabilities,
  parseCapability,
  resolveCapabilityDisposition
};
