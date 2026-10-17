/**
 * Archive metadata.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs");
// Read only package.json from an ASAR. No extraction, execution or dependency.
module.exports = function readMetadata(filename) {
  const descriptor = fs.openSync(filename, "r");
  function read(length, offset) {
    const buffer = Buffer.alloc(length);
    if (fs.readSync(descriptor, buffer, 0, length, offset) !== length)
      throw new Error("tidal_archive_truncated");
    return buffer;
  }
  try {
    const size = read(8, 0),
      headerSize = size.readUInt32LE(4);
    if (size.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 4000000)
      throw new Error("tidal_archive_header_invalid");
    const header = read(headerSize, 8),
      jsonSize = header.readUInt32LE(4);
    if (jsonSize > headerSize - 8) throw new Error("tidal_archive_header_invalid");
    const file = JSON.parse(header.subarray(8, 8 + jsonSize).toString("utf8")).files?.[
      "package.json"
    ];
    if (
      !file ||
      file.unpacked ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 65536 ||
      !/^\d+$/.test(file.offset)
    )
      throw new Error("tidal_archive_package_invalid");
    const offset = 8 + headerSize + Number(file.offset);
    if (!Number.isSafeInteger(offset)) throw new Error("tidal_archive_package_invalid");
    const manifest = JSON.parse(read(file.size, offset).toString("utf8"));
    if (
      typeof manifest.name !== "string" ||
      manifest.name.length > 128 ||
      typeof manifest.version !== "string" ||
      manifest.version.length > 80 ||
      typeof manifest.main !== "string"
    )
      throw new Error("tidal_archive_manifest_invalid");
    return manifest;
  } finally {
    fs.closeSync(descriptor);
  }
};
