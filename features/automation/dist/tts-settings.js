const QUEUE_POLICIES = Object.freeze(["queue", "replace", "skip-when-busy"]);

function text(value, maximum) {
  return typeof value === "string"
    ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, maximum).join("")
    : "";
}

function identifier(value) {
  const normalized = text(value, 80);
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(normalized) ? normalized : "";
}

function normalizeTtsSettings(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return Object.freeze({
    version: 1,
    voiceId: identifier(source.voiceId),
    outputId: identifier(source.outputId),
    volume: Math.max(0, Math.min(100, Math.round(Number(source.volume ?? 85) || 0))),
    rate: Math.max(0.5, Math.min(2, Math.round((Number(source.rate ?? 1) || 1) * 20) / 20)),
    pitch: Math.max(0.5, Math.min(2, Math.round((Number(source.pitch ?? 1) || 1) * 20) / 20)),
    queuePolicy: QUEUE_POLICIES.includes(source.queuePolicy) ? source.queuePolicy : "queue"
  });
}

function normalizePreviewText(value) {
  return text(value, 300).replace(/(?:https?:\/\/|www\.)\S+/giu, "link");
}

function projectRuntimeStatus(input) {
  const source = input && typeof input === "object" ? input : {};
  const rows = (value, maximum) => (Array.isArray(value) ? value : []).slice(0, maximum).map(row => ({
    id: identifier(row?.id),
    name: text(row?.name, 80),
    language: text(row?.language, 40),
    isDefault: row?.isDefault === true
  })).filter(row => row.id && row.name);
  return Object.freeze({
    engineName: text(source.engineName, 80),
    engineVersion: text(source.engineVersion, 40),
    voices: rows(source.voices, 64),
    outputs: rows(source.outputs, 32),
    active: source.active === true,
    queued: Math.max(0, Math.min(10, Math.trunc(Number(source.queued) || 0)))});
}

module.exports = { QUEUE_POLICIES, normalizePreviewText, normalizeTtsSettings, projectRuntimeStatus };
