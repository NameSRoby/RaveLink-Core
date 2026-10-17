/**
 * Read executable inline scripts using the same HTML parsing rules as a browser.
 * A regexp can miss permissive closing tags and quoted '>' attributes, silently
 * skipping code during lint. Do not enter template.content: template scripts are
 * inert until explicitly instantiated. External and data-script tags are excluded.
 */
module.exports = async function htmlScripts(html) {
  const { parse } = await import("parse5");
  const scripts = [];
  function visit(node) {
    if (node.tagName === "script") {
      const attributes = Object.fromEntries(
        node.attrs.map((attribute) => [attribute.name, attribute.value]),
      );
      const type = (attributes.type || "").trim().toLowerCase();
      if (
        !Object.hasOwn(attributes, "src") &&
        ["", "module", "text/javascript", "application/javascript"].includes(type)
      ) {
        scripts.push({
          code: node.childNodes.map((child) => child.value || "").join(""),
          module: type === "module",
        });
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(html));
  return scripts;
};
