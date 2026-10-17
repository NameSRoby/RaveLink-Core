module.exports = function archiveFixture() {
  const payload = Buffer.from(
    JSON.stringify({ name: "TIDAL", version: "2.43.2", main: "main.js" }),
  );
  const json = Buffer.from(
    JSON.stringify({
      files: { "package.json": { size: payload.length, offset: "0" } },
    }),
  );
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, payload]);
};
