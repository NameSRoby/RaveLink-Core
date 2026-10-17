/**
 * Archive.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const yauzl = require("yauzl"),
  zlib = require("node:zlib");
const { transform } = require("./vendor/spicetify/platform-hook.cjs");
const snapshotSource = require("./snapshot-source.cjs");
const LIMITS = {
  archive: 96 * 1024 * 1024,
  total: 256 * 1024 * 1024,
  file: 64 * 1024 * 1024,
  entries: 8192,
};
function safeName(name) {
  return (
    typeof name === "string" &&
    name.length <= 500 &&
    !/[\\\0:]/.test(name) &&
    !name.startsWith("/") &&
    !name.split("/").some((part) => part === ".." || part === ".") &&
    name !== ""
  );
}
function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > LIMITS.archive)
    return Promise.reject(Error("spotify_archive_size_invalid"));
  return new Promise((resolve, reject) => {
    // Spotify SPA files use rooted ZIP names. Validate these as virtual asset paths;
    // no archive entry is ever extracted to a filesystem path.
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: false },
      (error, zip) => {
        if (error) return reject(Error("spotify_archive_invalid"));
        const rows = [],
          names = new Set();
        let total = 0,
          settled = false;
        const fail = () => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(Error("spotify_archive_invalid"));
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (!settled) {
            settled = true;
            resolve(rows);
          }
        });
        zip.on("entry", (entry) => {
          const rawName = entry.fileName.toString("utf8"),
            name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
          const key = name.toLowerCase(),
            type = (entry.externalFileAttributes >>> 16) & 0xf000;
          total += entry.uncompressedSize;
          if (
            !Buffer.from(rawName).equals(entry.fileName) ||
            !(rawName === "/" || safeName(name)) ||
            names.has(key) ||
            rows.length >= LIMITS.entries ||
            entry.uncompressedSize > LIMITS.file ||
            total > LIMITS.total ||
            entry.generalPurposeBitFlag & 1 ||
            (type && ![0x8000, 0x4000].includes(type))
          )
            return fail();
          names.add(key);
          const row = {
            name,
            rawName,
            directory: rawName.endsWith("/"),
            date: entry.getLastModDate(),
            mode: entry.externalFileAttributes >>> 16,
            compression: entry.compressionMethod,
          };
          if (row.directory) {
            rows.push({ ...row, data: Buffer.alloc(0) });
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail();
            const chunks = [];
            let bytes = 0;
            stream.on("error", fail);
            stream.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > LIMITS.file || bytes > entry.uncompressedSize) {
                stream.destroy();
                fail();
              } else chunks.push(chunk);
            });
            stream.on("end", () => {
              if (settled) return;
              if (bytes !== entry.uncompressedSize) return fail();
              rows.push({ ...row, data: Buffer.concat(chunks) });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
async function writeArchive(rows) {
  if (!Array.isArray(rows) || rows.length > LIMITS.entries || typeof zlib.crc32 !== "function")
    throw Error("spotify_archive_writer_unavailable");
  const local = [],
    central = [];
  let offset = 0,
    total = 0;
  const names = new Set();
  for (const row of rows) {
    const rawName = row.rawName || row.name,
      logical = rawName.startsWith("/") ? rawName.slice(1) : rawName;
    if (
      !(rawName === "/" || safeName(logical)) ||
      names.has(logical.toLowerCase()) ||
      !Buffer.isBuffer(row.data) ||
      row.data.length > LIMITS.file
    )
      throw Error("spotify_archive_invalid");
    names.add(logical.toLowerCase());
    total += row.data.length;
    if (total > LIMITS.total) throw Error("spotify_archive_size_invalid");
    const filename = Buffer.from(rawName),
      method = row.directory || row.compression === 0 ? 0 : 8;
    const data = method === 8 ? zlib.deflateRawSync(row.data) : row.data,
      crc = zlib.crc32(row.data);
    const date = row.date || new Date("2000-01-01T00:00:00Z"),
      year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      dosTime =
        (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(row.data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(((row.mode || (row.directory ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
    if (offset > LIMITS.archive) throw Error("spotify_archive_size_invalid");
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(rows.length, 8);
  end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + directory.length + end.length > LIMITS.archive)
    throw Error("spotify_archive_size_invalid");
  return Buffer.concat([...local, directory, end]);
}
function injectHtml(text) {
  if (/ravelink-spotify|spicetify/i.test(text) || /<base\b/i.test(text))
    throw Error("spotify_html_modified");
  const script = /<script\b/i.exec(text);
  if (!script) throw Error("spotify_html_bootstrap_unavailable");
  for (const match of text.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*(["'])content-security-policy\1/i.test(match[0])) continue;
    const policy = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(match[0])?.[2];
    const directive =
      /(?:^|;)\s*script-src-elem\s+([^;]+)/i.exec(policy || "") ||
      /(?:^|;)\s*script-src\s+([^;]+)/i.exec(policy || "") ||
      /(?:^|;)\s*default-src\s+([^;]+)/i.exec(policy || "");
    if (
      match.index > script.index ||
      !policy ||
      (directive && !directive[1].split(/\s+/).includes("'self'"))
    )
      throw Error("spotify_html_policy_unsupported");
  }
  return (
    text.slice(0, script.index) +
    '<script src="/ravelink-spotify.js"></script>' +
    text.slice(script.index)
  );
}
async function prepareArchive(original, renderer, options = {}) {
  const rows = await readArchive(original);
  if (rows.some((row) => /^ravelink-spotify\.js$/i.test(row.name)))
    throw Error("spotify_asset_already_patched");
  const html = rows.find((row) => row.name === "index.html");
  if (!html) throw Error("spotify_html_missing");
  let extracted = false;
  if (!rows.some((row) => row.name === "xpui-modules.js") && options.snapshot) {
    rows.push({
      name: "xpui-modules.js",
      rawName: rows.some((row) => row.rawName?.startsWith("/"))
        ? "/xpui-modules.js"
        : "xpui-modules.js",
      data: Buffer.from(snapshotSource(options.snapshot)),
      compression: 8,
    });
    extracted = true;
  }
  const targets = rows.filter((row) =>
    ["xpui.js", "xpui-modules.js", "xpui-snapshot.js"].includes(row.name),
  );
  let hook = null;
  for (const row of targets) {
    const input = row.data.toString("utf8");
    if (!Buffer.from(input).equals(row.data)) throw Error("spotify_asset_encoding_invalid");
    const result = transform(input);
    if (result.ok) {
      if (hook) throw Error("spotify_platform_hook_ambiguous");
      hook = { row, result };
    } else if (result.error !== "spotify_platform_hook_unavailable") throw Error(result.error);
  }
  if (!hook) throw Error("spotify_platform_hook_unavailable");
  const text = html.data.toString("utf8");
  if (!Buffer.from(text).equals(html.data)) throw Error("spotify_asset_encoding_invalid");
  let patchedHtml = injectHtml(text);
  if (extracted) {
    const loader = /<script\b[^>]*src\s*=\s*(["'])\/xpui-snapshot\.js\1[^>]*>\s*<\/script>/gi;
    const matches = [...patchedHtml.matchAll(loader)];
    if (matches.length !== 1) throw Error("spotify_snapshot_loader_unavailable");
    patchedHtml = patchedHtml.replace(
      loader,
      '<script defer="defer" src="/xpui-modules.js"></script>$&',
    );
  }
  html.data = Buffer.from(patchedHtml);
  hook.row.data = Buffer.from(hook.result.code);
  rows.push({
    name: "ravelink-spotify.js",
    rawName: rows.some((row) => row.rawName?.startsWith("/"))
      ? "/ravelink-spotify.js"
      : "ravelink-spotify.js",
    data: Buffer.from(renderer),
    compression: 8,
  });
  return {
    archive: await writeArchive(rows),
    changes: ["index.html", hook.row.name, "ravelink-spotify.js"],
    platformAsset: hook.row.name,
    snapshotExtracted: extracted,
  };
}
module.exports = { readArchive, writeArchive, prepareArchive, injectHtml };
