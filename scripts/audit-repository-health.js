/**
 * Static repository health checks. Parse source rather than counting lines:
 * readable formatting and useful notes must not look like additional complexity.
 * Whole-file token fingerprints ignore comments/spacing, catching copied code
 * even after reformatting. Tiny compatibility re-exports are intentionally allowed.
 * Local literal imports must resolve; dynamic imports/build inventories still
 * require tests and review and are not claimed to be a complete reachability proof.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const espree = require("espree");
const { ROOT, sourceFiles } = require("./lib/source-inventory");

function audit(root = ROOT) {
  const files = sourceFiles(undefined, root).filter((file) => /\.(?:js|cjs|mjs)$/.test(file));
  const fingerprints = new Map();
  const errors = [];
  const metrics = [];
  let imports = 0;
  for (const relative of files) {
    const content = fs.readFileSync(path.join(root, relative), "utf8");
    let ast;
    try {
      ast = espree.parse(content, {
        ecmaVersion: "latest",
        sourceType: relative.startsWith("public/core/") ? "module" : "commonjs",
        tokens: true,
      });
    } catch (error) {
      errors.push(`${relative}: ${error.message}`);
      continue;
    }
    const tokens = ast.tokens.map((token) => [token.type, token.value]);
    if (tokens.length >= 100) {
      const hash = crypto.createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
      if (fingerprints.has(hash))
        errors.push(`${relative}: duplicate implementation of ${fingerprints.get(hash)}`);
      else fingerprints.set(hash, relative);
    }
    let branches = 0;
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "IfStatement") branches++;
      if (
        node.type === "CallExpression" &&
        node.callee?.name === "require" &&
        node.arguments.length === 1
      ) {
        const request = node.arguments[0].value;
        if (typeof request === "string" && request.startsWith(".")) {
          const target = path.resolve(root, path.dirname(relative), request);
          if (
            ![
              target,
              `${target}.js`,
              `${target}.cjs`,
              `${target}.json`,
              path.join(target, "index.js"),
            ].some((file) => fs.existsSync(file) && fs.statSync(file).isFile())
          ) {
            errors.push(`${relative}: unresolved local import ${request}`);
          }
          imports++;
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "tokens") continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(ast);
    metrics.push({ file: relative, tokens: tokens.length, branches });
  }
  return {
    ok: errors.length === 0,
    files: files.length,
    imports,
    errors,
    metrics,
  };
}

if (require.main === module) {
  const result = audit();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    result.errors.forEach((error) => console.error(`[HEALTH] ${error}`));
    console.log(
      `[HEALTH] ${result.files} JavaScript files; ${result.imports} local imports; ${result.errors.length} errors.`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}
module.exports = { audit };
