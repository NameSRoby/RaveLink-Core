// [TITLE] Module: capabilities/mod-platform/packages/mod-package-archive.js
// [TITLE] Purpose: safely extract a bounded ZIP mod package into private staging
// [TITLE] Functionality Index:
// [TITLE] - preflight every central-directory entry before writing files
// [TITLE] - reject links, special files, unsafe names, collisions, and ZIP bombs
// [TITLE] - stream files under declared and measured expansion limits

const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const { isSafePackagePath } = require("../contracts/mod-manifest-v1");

const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 2048,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 16,
  maxPathBytes: 512
});
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_UNSAFE_RE = /[<>:"|?*\u0000-\u001f]/;

function boundedArchiveLimits(overrides = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_ARCHIVE_LIMITS)) {
    const value = Number(overrides[key]);
    out[key] = Number.isFinite(value) && value > 0 ? Math.min(value, fallback) : fallback;
  }
  return out;
}

function archivePathIsPortable(fileName) {
  if (!isSafePackagePath(fileName)) return false;
  return fileName.split("/").every(segment => (
    segment.length <= 120
    && !WINDOWS_UNSAFE_RE.test(segment)
    && !/[. ]$/.test(segment)
    && !WINDOWS_RESERVED_NAME_RE.test(segment)
  ));
}

function unixEntryType(entry) {
  const host = (entry.versionMadeBy >>> 8) & 0xff;
  return host === 3 ? ((entry.externalFileAttributes >>> 16) & 0xf000) : 0;
}

function classifyEntry(entry) {
  const directory = entry.fileName.endsWith("/");
  const unixType = unixEntryType(entry);
  if (unixType === 0xa000) return "link";
  if (unixType && unixType !== 0x8000 && unixType !== 0x4000) return "special";
  if (directory && unixType === 0x8000) return "invalid";
  if (!directory && unixType === 0x4000) return "invalid";
  return directory ? "directory" : "file";
}

function compressionRatio(entry) {
  if (entry.uncompressedSize === 0) return 0;
  if (entry.compressedSize === 0) return Infinity;
  return entry.uncompressedSize / entry.compressedSize;
}

function addPathEntry(pathKinds, relative, kind) {
  const key = relative.toLowerCase();
  if (pathKinds.has(key)) {
    return pathKinds.get(key).path === relative ? "archive_duplicate_path" : "archive_case_collision";
  }
  const segments = relative.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const parentKey = segments.slice(0, index).join("/").toLowerCase();
    if (pathKinds.get(parentKey)?.kind === "file") return "archive_path_conflict";
  }
  if (kind === "file") {
    for (const existingKey of pathKinds.keys()) {
      if (existingKey.startsWith(`${key}/`)) return "archive_path_conflict";
    }
  }
  pathKinds.set(key, { path: relative, kind });
  return "";
}

async function extractZipArchive(archivePath, destinationPath, options = {}) {
  const limits = boundedArchiveLimits(options.limits);
  const archive = path.resolve(String(archivePath || ""));
  const destination = path.resolve(String(destinationPath || ""));
  let stat;
  try { stat = await fs.promises.lstat(archive); } catch { return { ok: false, error: "archive_missing" }; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: "archive_invalid" };
  if (stat.size > limits.maxArchiveBytes) return { ok: false, error: "archive_size_limit" };
  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.mkdir(destination, { recursive: false });
  } catch {
    return { ok: false, error: "archive_destination_invalid" };
  }

  let zipfile;
  try {
    zipfile = await yauzl.openPromise(archive, {
      autoClose: false,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    });
    if (zipfile.fileSize > limits.maxArchiveBytes) throw new Error("archive_size_limit");
    if (zipfile.entryCount > limits.maxEntries) throw new Error("archive_entry_count_limit");
    const entries = [];
    const pathKinds = new Map();
    let expandedBytes = 0;
    let compressedBytes = 0;
    for await (const entry of zipfile.eachEntry()) {
      if (entries.length >= limits.maxEntries) throw new Error("archive_entry_count_limit");
      if (entry.fileNameLength > limits.maxPathBytes) throw new Error("archive_path_too_long");
      const kind = classifyEntry(entry);
      if (kind === "link") throw new Error("archive_link_not_allowed");
      if (kind === "special") throw new Error("archive_special_file_not_allowed");
      if (kind === "invalid") throw new Error("archive_entry_type_mismatch");
      const relative = kind === "directory" ? entry.fileName.slice(0, -1) : entry.fileName;
      if (!archivePathIsPortable(relative)) throw new Error("archive_unsafe_path");
      if (relative.split("/").length > limits.maxDepth) throw new Error("archive_depth_limit");
      const conflict = addPathEntry(pathKinds, relative, kind);
      if (conflict) throw new Error(conflict);
      if (kind === "directory") {
        if (entry.uncompressedSize !== 0) throw new Error("archive_directory_has_data");
      } else {
        if (entry.isEncrypted() || !entry.canDecodeFileData()) throw new Error("archive_encoding_unsupported");
        if (entry.uncompressedSize > limits.maxFileBytes) throw new Error("archive_file_too_large");
        if (compressionRatio(entry) > limits.maxCompressionRatio) throw new Error("archive_compression_ratio_limit");
        expandedBytes += entry.uncompressedSize;
        compressedBytes += entry.compressedSize;
        if (expandedBytes > limits.maxExpandedBytes) throw new Error("archive_expanded_size_limit");
        if (compressedBytes > 0 && expandedBytes / compressedBytes > limits.maxCompressionRatio) {
          throw new Error("archive_compression_ratio_limit");
        }
      }
      entries.push({ entry, kind, relative });
    }

    let measuredBytes = 0;
    for (const row of entries) {
      const outputPath = path.join(destination, ...row.relative.split("/"));
      if (row.kind === "directory") {
        await fs.promises.mkdir(outputPath, { recursive: true });
        continue;
      }
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      let fileBytes = 0;
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          fileBytes += chunk.length;
          measuredBytes += chunk.length;
          if (fileBytes > limits.maxFileBytes || measuredBytes > limits.maxExpandedBytes) {
            callback(new Error("archive_stream_size_limit"));
          } else {
            callback(null, chunk);
          }
        }
      });
      const input = await zipfile.openReadStreamPromise(row.entry);
      await pipeline(input, meter, fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
      if (fileBytes !== row.entry.uncompressedSize) throw new Error("archive_entry_size_mismatch");
    }
    return { ok: true, root: destination, entries: entries.length, expandedBytes: measuredBytes };
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
    const message = String(error?.message || error);
    const known = message.match(/archive_[a-z_]+/)?.[0];
    return { ok: false, error: known || "archive_invalid_zip", detail: known ? undefined : message.slice(0, 160) };
  } finally {
    zipfile?.close();
  }
}

module.exports = {
  DEFAULT_ARCHIVE_LIMITS,
  archivePathIsPortable,
  boundedArchiveLimits,
  classifyEntry,
  extractZipArchive
};
