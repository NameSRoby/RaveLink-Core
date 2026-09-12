// [TITLE] Module: shared/fs/json-file-store.js
// [TITLE] Purpose: safe JSON disk IO helpers
// [TITLE] Functionality Index:
// [TITLE] - clone JSON-safe values
// [TITLE] - read JSON with deterministic fallback handling
// [TITLE] - write JSON with directory creation and canonical formatting

const fs = require("fs");
const path = require("path");

function cloneJsonSafe(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function readJsonFileWithMetadata(filePath, fallback = {}) {
  const target = String(filePath || "").trim();
  for (const candidate of [target, target ? `${target}.bak` : ""]) {
    if (!candidate) continue;
    try {
      return { value: JSON.parse(fs.readFileSync(candidate, "utf8")), source: candidate === target ? "primary" : "backup", recovered: candidate !== target };
    } catch {}
  }
  return { value: cloneJsonSafe(fallback, fallback), source: "fallback", recovered: false };
}

function readJsonFile(filePath, fallback = {}) {
  return readJsonFileWithMetadata(filePath, fallback).value;
}

function writeJsonFile(filePath, value, options = {}) {
  // [DEV] Write path is guarded so callers cannot silently write to empty path tokens.
  const target = String(filePath || "").trim();
  if (!target) {
    throw new Error("writeJsonFile requires a valid file path");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  const backup = `${target}.bak`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: options.mode });
    if (options.backup !== false && fs.existsSync(target)) fs.copyFileSync(target, backup);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return value;
}

module.exports = {
  cloneJsonSafe,
  readJsonFile,
  readJsonFileWithMetadata,
  writeJsonFile
};
