/** Local raster media only. Executable SVG, remote URLs and user paths are never
 * accepted. Assets remain private runtime data, addressed by content digest. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { fault } = require("./control-deck-config");
const validId = (id) => typeof id === "string" && /^[a-f0-9]{64}\.(png|jpg|gif|mp4|webm)$/.test(id);
function inspect(bytes, type, screen = false) {
  const video = screen && ["video/mp4", "video/webm"].includes(type);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 10 ||
    bytes.length > (video ? 16777216 : screen ? 8388608 : 2097152)
  )
    throw fault("control_deck_media_invalid");
  if (video) {
    const mp4 =
      type === "video/mp4" &&
      bytes.toString("ascii", 4, 8) === "ftyp" &&
      /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |qt  )$/.test(bytes.toString("ascii", 8, 12));
    const webm =
      type === "video/webm" &&
      bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
      bytes.subarray(0, 256).includes(Buffer.from("webm"));
    if (!mp4 && !webm) throw fault("control_deck_media_invalid");
    return { extension: mp4 ? "mp4" : "webm", width: null, height: null, type };
  }
  let width = 0,
    height = 0,
    extension;
  if (
    type === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    extension = "png";
  } else if (type === "image/gif" && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
    extension = "gif";
  } else if (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (at + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || at + size > bytes.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        size >= 8
      ) {
        height = bytes.readUInt16BE(at + 3);
        width = bytes.readUInt16BE(at + 5);
        extension = "jpg";
        break;
      }
      at += size;
    }
  }
  if (
    !extension ||
    width < 1 ||
    height < 1 ||
    width > (screen ? 4096 : 2048) ||
    height > (screen ? 4096 : 2048)
  )
    throw fault("control_deck_media_invalid");
  return { extension, width, height, type };
}
module.exports = function media(runtimeDir) {
  const directory = path.join(runtimeDir, "control-deck", "media");
  function store(bytes, type, screen = false) {
    const metadata = inspect(bytes, type, screen);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink()) throw fault("control_deck_media_invalid");
    const id = crypto.createHash("sha256").update(bytes).digest("hex") + "." + metadata.extension;
    const target = path.join(directory, id);
    if (!fs.existsSync(target)) {
      const files = fs
        .readdirSync(directory)
        .filter(validId)
        .map((name) => fs.lstatSync(path.join(directory, name)));
      if (
        files.length >= 128 ||
        files.reduce((sum, stat) => sum + stat.size, 0) + bytes.length > 100663296
      )
        throw fault("control_deck_media_limit");
      fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    return {
      id,
      url: "/api/control-deck/media/" + id,
      type: metadata.type,
      width: metadata.width,
      height: metadata.height,
    };
  }
  function read(id) {
    if (!validId(id)) throw fault("control_deck_media_invalid");
    const file = path.join(directory, id),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16777216)
      throw fault("control_deck_media_invalid");
    return {
      file,
      type: {
        png: "image/png",
        jpg: "image/jpeg",
        gif: "image/gif",
        mp4: "video/mp4",
        webm: "video/webm",
      }[id.split(".")[1]],
    };
  }
  return { store, storeScreen: (bytes, type) => store(bytes, type, true), read };
};
module.exports.inspect = inspect;
