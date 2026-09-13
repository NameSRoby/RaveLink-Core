// [TITLE] Module: domains/system/core-update.service.js
// [TITLE] Purpose: opt-in, verified GitHub release discovery and Windows update staging

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPOSITORY = "NameSRoby/RaveLink-Core";
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 750 * 1024 * 1024;

function parseVersion(value) {
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error("invalid_release_version");
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function localVersion(rootDir) {
  const release = readJson(path.join(rootDir, "RELEASE_BUILD.json"));
  const pkg = readJson(path.join(rootDir, "package.json"), {});
  return String(release?.version || pkg.version || "0.0.0").replace(/-dev$/i, "");
}

function safeAsset(release, name) {
  const asset = Array.isArray(release?.assets) ? release.assets.find(row => row?.name === name) : null;
  if (!asset) throw new Error(`release_asset_missing:${name}`);
  const url = new URL(String(asset.browser_download_url || ""));
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) {
    throw new Error("release_asset_origin_invalid");
  }
  return { name, url: url.href, size: Number(asset.size || 0) };
}

async function readLimited(response, maximum) {
  if (!response.ok) throw new Error(`release_http_${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maximum) throw new Error("release_response_too_large");
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body || []) {
    received += chunk.length;
    if (received > maximum) throw new Error("release_response_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, received);
}

async function downloadFile(fetchImpl, url, destination, maximum) {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120000), headers: { "User-Agent": "RaveLink-Core-Updater", Accept: "application/octet-stream" } });
  if (!response.ok) throw new Error(`release_http_${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maximum) throw new Error("release_archive_too_large");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const hash = crypto.createHash("sha256");
  let received = 0;
  try {
    if (!response.body) throw new Error("release_archive_empty");
    const meter = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maximum) return callback(new Error("release_archive_too_large"));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, output);
    fs.renameSync(temporary, destination);
    return { bytes: received, sha256: hash.digest("hex") };
  } catch (error) {
    output.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function createCoreUpdateService(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "../../.."));
  const runtimeDir = path.resolve(options.runtimeDir || path.join(rootDir, "runtime"));
  const updateDir = path.join(runtimeDir, "updates");
  const settingsPath = path.join(updateDir, "settings.json");
  const stagedPath = path.join(updateDir, "staged.json");
  const availableRollbackPath = path.join(updateDir, "available-rollback.json");
  const fetchImpl = options.fetch || globalThis.fetch;
  let latest = null;
  let checking = false;
  let downloading = false;
  let lastError = "";

  function settings() {
    const value = readJson(settingsPath, {});
    return { checkOnLaunch: value?.checkOnLaunch === true };
  }

  function status() {
    const currentVersion = localVersion(rootDir);
    const staged = readJson(stagedPath);
    const rollback = readJson(availableRollbackPath);
    return {
      ok: true,
      currentVersion,
      checkOnLaunch: settings().checkOnLaunch,
      checking,
      downloading,
      latest: latest ? { version: latest.version, name: latest.name, publishedAt: latest.publishedAt, available: compareVersions(currentVersion, latest.version) < 0 } : null,
      staged: staged ? { version: staged.version, verified: staged.verified === true } : null,
      rollback: rollback ? { version: String(rollback.previousVersion || "") } : null,
      hosted: process.env.RAVELINK_WINDOWS_HOST === "1",
      lastError
    };
  }

  function configure(value = {}) {
    writeJsonAtomic(settingsPath, { checkOnLaunch: value.checkOnLaunch === true });
    return status();
  }

  async function check() {
    if (checking) throw new Error("update_check_in_progress");
    checking = true;
    lastError = "";
    try {
      const response = await fetchImpl(RELEASE_API, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "RaveLink-Core-Updater", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
      const body = JSON.parse((await readLimited(response, MAX_METADATA_BYTES)).toString("utf8"));
      if (body?.draft || body?.prerelease) throw new Error("release_is_not_stable");
      const version = String(body?.tag_name || "").replace(/^v/, "");
      if (!parseVersion(version)) throw new Error("invalid_release_version");
      const archiveName = `RaveLink-Core-Windows-v${version}-self-contained.zip`;
      latest = {
        version,
        name: String(body.name || `RaveLink Core v${version}`).slice(0, 160),
        publishedAt: String(body.published_at || "").slice(0, 64),
        archive: safeAsset(body, archiveName),
        checksums: safeAsset(body, "SHA256SUMS.txt")
      };
    } catch (error) {
      lastError = String(error?.message || "update_check_failed").slice(0, 160);
      throw error;
    } finally { checking = false; }
    return status();
  }

  async function download() {
    if (downloading) throw new Error("update_download_in_progress");
    downloading = true;
    try {
      if (!latest) await check();
      if (compareVersions(localVersion(rootDir), latest.version) >= 0) throw new Error("no_newer_release");
      const checksumResponse = await fetchImpl(latest.checksums.url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "RaveLink-Core-Updater", Accept: "text/plain" } });
      const checksumText = (await readLimited(checksumResponse, MAX_CHECKSUM_BYTES)).toString("ascii");
      const escapedName = latest.archive.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^([a-fA-F0-9]{64})[ \\t]+\\*?${escapedName}$`, "m").exec(checksumText);
      if (!match) throw new Error("release_checksum_missing");
      const downloadsDir = path.join(updateDir, "downloads");
      fs.rmSync(downloadsDir, { recursive: true, force: true });
      const archivePath = path.join(downloadsDir, latest.archive.name);
      const downloaded = await downloadFile(fetchImpl, latest.archive.url, archivePath, MAX_ARCHIVE_BYTES);
      if (downloaded.sha256 !== match[1].toLowerCase()) {
        fs.rmSync(archivePath, { force: true });
        throw new Error("release_checksum_mismatch");
      }
      writeJsonAtomic(stagedPath, { version: latest.version, archivePath, sha256: downloaded.sha256, bytes: downloaded.bytes, verified: true, stagedAt: new Date().toISOString() });
    } finally { downloading = false; }
    return status();
  }

  function launchHelper(action) {
    if (process.platform !== "win32" || process.env.RAVELINK_WINDOWS_HOST !== "1") throw new Error("windows_host_required");
    const staged = readJson(stagedPath);
    if (action === "Apply" && (!staged?.verified || !fs.existsSync(staged.archivePath))) throw new Error("verified_update_required");
    if (action === "Rollback" && !fs.existsSync(availableRollbackPath)) throw new Error("rollback_unavailable");
    const source = path.join(rootDir, "scripts", "ravelink-update.ps1");
    if (!fs.existsSync(source)) throw new Error("update_helper_missing");
    fs.mkdirSync(updateDir, { recursive: true });
    const runner = path.join(updateDir, "ravelink-update-runner.ps1");
    fs.copyFileSync(source, runner);
    const hostPid = Number(process.env.RAVELINK_HOST_PID || 0);
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner, "-Action", action, "-Root", rootDir, "-HostPid", String(hostPid)], { detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
    setTimeout(() => {
      try { spawn(path.join(rootDir, "RaveLink-Core.exe"), ["--stop"], { detached: true, windowsHide: true, stdio: "ignore" }).unref(); }
      catch { options.requestShutdown?.("update"); }
    }, 250).unref();
    return { ok: true, action: action.toLowerCase(), stopping: true };
  }

  function startLaunchCheck() {
    if (!settings().checkOnLaunch) return;
    const timer = setTimeout(() => check().catch(() => {}), Number(options.launchDelayMs ?? 5000));
    timer.unref?.();
  }

  return Object.freeze({ status, configure, check, download, apply: () => launchHelper("Apply"), rollback: () => launchHelper("Rollback"), startLaunchCheck });
}

module.exports = { createCoreUpdateService, compareVersions, parseVersion, RELEASE_API };
