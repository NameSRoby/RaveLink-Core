const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { extractZipArchive } = require("../../mod-platform/packages/mod-package-archive");
const { validateOfficialTtsPayload } = require("./official-tts-payloads");

const DESCRIPTOR = "ravelink.tts-payload.json";
const ID_RE = /^tts-(?:runtime|voice)-[a-z0-9-]{1,52}$/;
const ARCHIVE_CEILINGS = Object.freeze({
  maxArchiveBytes: 96 * 1024 * 1024, maxEntries: 2048,
  maxExpandedBytes: 160 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200, maxDepth: 16, maxPathBytes: 512
});

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target) {
  try { await fs.promises.lstat(target); return true; } catch { return false; }
}

async function downloadAsset(entry, target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("tts_payload_fetch_unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(options.timeoutMs) || 120000, 5000), 300000));
  timeout.unref?.();
  try {
    const response = await fetchImpl(entry.url, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { accept: "application/zip", "user-agent": "RaveLink-Core-TTS-Payload/1" }
    });
    if (!response?.ok) throw new Error(`tts_payload_http_${Number(response?.status) || 0}`);
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared !== entry.bytes) throw new Error("tts_payload_size_mismatch");
    if (!response.body) throw new Error("tts_payload_empty");
    const hash = crypto.createHash("sha256");
    let received = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > entry.bytes) return callback(new Error("tts_payload_size_mismatch"));
      hash.update(chunk); callback(null, chunk);
    }});
    const input = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
    await pipeline(input, meter, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }));
    if (received !== entry.bytes) throw new Error("tts_payload_size_mismatch");
    if (hash.digest("hex") !== entry.sha256) throw new Error("tts_payload_hash_mismatch");
    return { bytes: received };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("tts_payload_timeout");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function readDescriptor(root, entry) {
  let raw;
  try { raw = await fs.promises.readFile(path.join(root, DESCRIPTOR), "utf8"); } catch { throw new Error("tts_payload_descriptor_missing"); }
  if (Buffer.byteLength(raw, "utf8") > 16384) throw new Error("tts_payload_descriptor_too_large");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("tts_payload_descriptor_invalid"); }
  if (!value || value.schemaVersion !== 1 || value.id !== entry.id || value.version !== entry.version || value.kind !== entry.kind) {
    throw new Error("tts_payload_descriptor_mismatch");
  }
  return value;
}

module.exports = function createTtsPayloadManager(options = {}) {
  const root = path.resolve(options.root || path.join(process.cwd(), "runtime", "features", "tts-payloads"));
  const catalog = new Map((options.catalog || []).map(validateOfficialTtsPayload).filter(Boolean).map(row => [row.id, row]));
  let mutation = Promise.resolve();
  const serialize = work => { const next = mutation.then(work, work); mutation = next.catch(() => undefined); return next; };

  async function status() {
    const packages = [];
    for (const entry of catalog.values()) {
      const target = path.join(root, entry.id);
      let installedVersion = "";
      if (inside(root, target) && await exists(target)) {
        try { installedVersion = String(JSON.parse(await fs.promises.readFile(path.join(target, DESCRIPTOR), "utf8")).version || ""); } catch {}
      }
      packages.push({ ...entry, installed: Boolean(installedVersion), installedVersion, updateAvailable: Boolean(installedVersion && installedVersion !== entry.version), source: "github", downloadRequired: true });
    }
    return { ok: true, packages };
  }

  function install(idRaw) {
    return serialize(async () => {
      const id = String(idRaw || "");
      const entry = ID_RE.test(id) ? catalog.get(id) : null;
      if (!entry) return { ok: false, error: "tts_payload_not_allowed" };
      await fs.promises.mkdir(root, { recursive: true });
      const nonce = `${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
      const archive = path.join(root, `.${id}.${nonce}.zip`);
      const staging = path.join(root, `.${id}.${nonce}.staging`);
      const target = path.join(root, id);
      const rollback = path.join(root, `.${id}.${nonce}.rollback`);
      if (![archive, staging, target, rollback].every(value => inside(root, value))) return { ok: false, error: "tts_payload_path_invalid" };
      let movedCurrent = false;
      try {
        await downloadAsset(entry, archive, options);
        const extraction = await extractZipArchive(archive, staging, {
          limits: { maxArchiveBytes: entry.bytes, maxEntries: entry.files, maxExpandedBytes: entry.expandedBytes, maxFileBytes: 64 * 1024 * 1024, maxCompressionRatio: 200, maxDepth: 16, maxPathBytes: 512 },
          limitCeilings: ARCHIVE_CEILINGS
        });
        if (!extraction.ok) throw new Error(extraction.error);
        if (extraction.entries !== entry.files) throw new Error("tts_payload_file_count_mismatch");
        await readDescriptor(staging, entry);
        if (await exists(target)) { await fs.promises.rename(target, rollback); movedCurrent = true; }
        await fs.promises.rename(staging, target);
        if (movedCurrent) await fs.promises.rm(rollback, { recursive: true, force: true });
        return { ok: true, id, version: entry.version, installed: true };
      } catch (error) {
        if (movedCurrent && !await exists(target) && await exists(rollback)) await fs.promises.rename(rollback, target).catch(() => undefined);
        return { ok: false, error: String(error?.message || "tts_payload_install_failed").slice(0, 120) };
      } finally {
        await fs.promises.rm(archive, { force: true }).catch(() => undefined);
        if (await exists(staging)) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        if (await exists(rollback)) await fs.promises.rm(rollback, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  function remove(idRaw) {
    return serialize(async () => {
      const id = String(idRaw || "");
      if (!catalog.has(id)) return { ok: false, error: "tts_payload_not_allowed" };
      const target = path.join(root, id);
      if (!inside(root, target) || !await exists(target)) return { ok: false, error: "tts_payload_not_installed" };
      const quarantine = path.join(root, `.${id}.${process.pid}-${crypto.randomBytes(5).toString("hex")}.remove`);
      try {
        await fs.promises.rename(target, quarantine);
        await fs.promises.rm(quarantine, { recursive: true, force: true });
        return { ok: true, id, installed: false };
      } catch (error) {
        if (!await exists(target) && await exists(quarantine)) await fs.promises.rename(quarantine, target).catch(() => undefined);
        return { ok: false, error: String(error?.message || "tts_payload_remove_failed").slice(0, 120) };
      }
    });
  }

  return Object.freeze({ install, remove, status });
};

module.exports.downloadAsset = downloadAsset;
