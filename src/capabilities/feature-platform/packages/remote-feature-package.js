const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { boundedLimits, isSafePackagePath } = require("../../../shared/packages/package-directory-integrity");
const { validateFeatureManifestV1 } = require("../contracts/feature-manifest-v1");

const MANIFEST_NAME = "ravelink.feature.json";
const OFFICIAL_HOST = "raw.githubusercontent.com";
const OFFICIAL_PREFIX = "/NameSRoby/RaveLink-Core/refs/heads/main/features/";

function validateOfficialSource(source) {
  if (!source || typeof source !== "object" || !/^[a-z][a-z0-9-]{1,63}$/.test(String(source.id || ""))) return null;
  let base;
  try { base = new URL(String(source.baseUrl || "")); } catch { return null; }
  if (base.protocol !== "https:" || base.hostname !== OFFICIAL_HOST || base.port || !base.pathname.startsWith(OFFICIAL_PREFIX) || !base.pathname.endsWith("/")) return null;
  const expectedSuffix = `/${source.id}/`;
  if (!base.pathname.endsWith(expectedSuffix)) return null;
  return Object.freeze({
    id: String(source.id),
    name: String(source.name || source.id).slice(0, 80),
    description: String(source.description || "").slice(0, 500),
    baseUrl: base.toString(),
    displaySource: String(source.displaySource || "GitHub").slice(0, 80)
  });
}

function fileUrl(source, relative) {
  if (!isSafePackagePath(relative)) throw new Error("remote_feature_path_invalid");
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  const url = new URL(encoded, source.baseUrl);
  const base = new URL(source.baseUrl);
  if (url.protocol !== "https:" || url.hostname !== base.hostname || !url.pathname.startsWith(base.pathname)) throw new Error("remote_feature_url_invalid");
  return url.toString();
}

async function fetchBuffer(url, maximumBytes, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("remote_feature_fetch_unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(options.timeoutMs) || 10000, 1000), 30000));
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/octet-stream", "user-agent": "RaveLink-Core-Feature-Installer/1" }
    });
    if (!response?.ok) throw new Error(`remote_feature_http_${Number(response?.status) || 0}`);
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("remote_feature_file_too_large");
    if (!response.body?.getReader) {
      const fallback = Buffer.from(await response.arrayBuffer());
      if (fallback.length > maximumBytes) throw new Error("remote_feature_file_too_large");
      return fallback;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      bytes += row.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("remote_feature_file_too_large");
      }
      chunks.push(Buffer.from(row.value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("remote_feature_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRemoteManifest(sourceInput, options = {}) {
  const source = validateOfficialSource(sourceInput);
  if (!source) return { ok: false, error: "remote_feature_source_invalid" };
  const limits = boundedLimits(options.limits);
  try {
    const body = await fetchBuffer(fileUrl(source, MANIFEST_NAME), limits.maxManifestBytes, options);
    const input = JSON.parse(body.toString("utf8"));
    const validated = validateFeatureManifestV1(input);
    if (!validated.ok || validated.value.id !== source.id) return { ok: false, error: "remote_feature_manifest_invalid", manifestErrors: validated.errors };
    return { ok: true, source, manifest: validated.value, manifestBytes: body.length, manifestBody: body };
  } catch (error) {
    return { ok: false, error: String(error?.message || "remote_feature_manifest_unavailable").slice(0, 160) };
  }
}

async function downloadRemotePackage(sourceInput, destination, options = {}) {
  const limits = boundedLimits(options.limits);
  const remote = options.remote?.ok ? options.remote : await fetchRemoteManifest(sourceInput, options);
  if (!remote.ok) return remote;
  const files = Object.entries(remote.manifest.integrity.files);
  if (files.length + 1 > limits.maxFiles) return { ok: false, error: "package_file_count_limit" };
  let totalBytes = remote.manifestBytes;
  try {
    await fs.promises.mkdir(destination, { recursive: false });
    await fs.promises.writeFile(path.join(destination, MANIFEST_NAME), remote.manifestBody, { flag: "wx", mode: 0o600 });
    for (const [relative, expectedHash] of files) {
      const remaining = limits.maxPackageBytes - totalBytes;
      if (remaining <= 0) throw new Error("package_size_limit");
      const body = await fetchBuffer(fileUrl(remote.source, relative), Math.min(limits.maxFileBytes, remaining), options);
      const actualHash = crypto.createHash("sha256").update(body).digest("hex");
      if (actualHash !== expectedHash) throw new Error("integrity_hash_mismatch");
      totalBytes += body.length;
      const output = path.join(destination, ...relative.split("/"));
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      await fs.promises.writeFile(output, body, { flag: "wx", mode: 0o600 });
    }
    return { ok: true, root: destination, manifest: remote.manifest, totalBytes };
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: String(error?.message || "remote_feature_download_failed").slice(0, 160) };
  }
}

module.exports = { downloadRemotePackage, fetchBuffer, fetchRemoteManifest, fileUrl, validateOfficialSource };
