/** Inline declared local styles/scripts so opaque UI frames need no network.
 * Recheck bytes when read; do not open undeclared or escaped package paths. */
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
module.exports = async function bundleModPanel(content, entry, root, manifest) {
  const attribute = (tag, name) =>
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
      .exec(tag)
      ?.slice(1)
      .find((v) => v !== undefined);
  async function asset(name, extension) {
    if (!name || /[\\?#:]|^\//.test(name)) throw Error("ui_asset_path_invalid");
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(entry), name));
    if (
      relative.startsWith("../") ||
      !relative.endsWith(extension) ||
      !Object.hasOwn(manifest.integrity.files, relative)
    )
      throw Error("ui_asset_not_declared");
    const bytes = await fs.readFile(path.join(root, ...relative.split("/")));
    if (
      bytes.length > 262144 ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== manifest.integrity.files[relative]
    )
      throw Error("package_integrity_invalid");
    return bytes.toString("utf8");
  }
  async function replace(pattern, render) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const replacement = await render(match[0]);
      content = content.replace(match[0], () => replacement);
    }
  }
  await replace(/<link\b[^>]*>/gi, async (tag) =>
    attribute(tag, "rel")?.toLowerCase() === "stylesheet"
      ? "<style>" +
        (await asset(attribute(tag, "href"), ".css")).replace(/<\/style/gi, "<\\/style") +
        "</style>"
      : tag,
  );
  await replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script\s*>/gi, async (tag) => {
    const script = await asset(attribute(tag, "src"), ".js");
    return tag
      .replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(
        />[\s\S]*<\/script\s*>$/i,
        () => ">" + script.replace(/<\/script/gi, "<\\/script") + "</script>",
      );
  });
  if (Buffer.byteLength(content) > 262144) throw Error("ui_contribution_size_limit");
  return content;
};
