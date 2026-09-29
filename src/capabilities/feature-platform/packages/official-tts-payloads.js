const REPOSITORY = "NameSRoby/RaveLink-Core";
const ID_RE = /^tts-(?:runtime|voice)-[a-z0-9-]{1,52}$/;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.zip$/;

function validateOfficialTtsPayload(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "");
  const version = String(input.version || "");
  const tag = String(input.tag || "");
  const asset = String(input.asset || "");
  const sha256 = String(input.sha256 || "").toLowerCase();
  const bytes = Number(input.bytes);
  const expandedBytes = Number(input.expandedBytes);
  const files = Number(input.files);
  if (!ID_RE.test(id) || !VERSION_RE.test(version) || !/^(?:tts-)?v[0-9][0-9A-Za-z.-]{1,60}$/.test(tag)) return null;
  if (!ASSET_RE.test(asset) || !SHA256_RE.test(sha256)) return null;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 96 * 1024 * 1024) return null;
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes < bytes || expandedBytes > 160 * 1024 * 1024) return null;
  if (!Number.isSafeInteger(files) || files < 1 || files > 2048) return null;
  const url = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
  return Object.freeze({
    id, version, tag, asset, sha256, bytes, expandedBytes, files, url,
    kind: id.startsWith("tts-runtime-") ? "runtime" : "voice",
    name: String(input.name || id).slice(0, 80),
    description: String(input.description || "").slice(0, 500),
    language: String(input.language || "").slice(0, 35),
    license: String(input.license || "").slice(0, 80)
  });
}

// Entries are admitted only after a deterministic release asset has a final
// inventory, exact byte count, and SHA-256 recorded for its release tag.
const OFFICIAL_TTS_PAYLOADS = Object.freeze([
  validateOfficialTtsPayload({
    id: "tts-voice-kitten-en",
    name: "Kitten English Voice Pack",
    description: "Eight offline English voice styles using the Apache-2.0 Sherpa ONNX runtime and Kitten Nano model.",
    version: "1.0.0",
    tag: "v0.6.4",
    asset: "RaveLink-TTS-Kitten-English-v1.0.0.zip",
    sha256: "c358b3c7e25f6083720498fe95a2fcd1f9c21a02fbcae76af80b6220f95d91cb",
    bytes: 37544980,
    expandedBytes: 65334986,
    files: 375,
    language: "en-US",
    license: "Apache-2.0"
  })
].filter(Boolean));

module.exports = { OFFICIAL_TTS_PAYLOADS, validateOfficialTtsPayload };
