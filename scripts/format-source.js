/** One formatting policy for authored code; generated pages use their source builders. */
const fs = require("node:fs");
const path = require("node:path");
const prettier = require("prettier");
const { ROOT, GENERATED_PAGES, sourceFiles } = require("./lib/source-inventory");
const EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".css",
  ".html",
  ".json",
  ".md",
  ".yml",
  ".yaml",
]);

async function main() {
  const write = process.argv.includes("--write");
  const files = sourceFiles().filter(
    (file) =>
      EXTENSIONS.has(path.extname(file)) &&
      !GENERATED_PAGES.has(file) &&
      !file.endsWith("/ravelink.feature.json"),
  );
  for (const file of [
    ".prettierrc.json",
    "eslint.config.cjs",
    "docs/DEVELOPMENT.md",
    "docs/REPOSITORY_HEALTH.md",
  ]) {
    if (fs.existsSync(path.join(ROOT, file))) files.push(file);
  }
  const config = await prettier.resolveConfig(path.join(ROOT, "package.json"));
  let stale = 0;
  for (const relative of files) {
    const file = path.join(ROOT, relative);
    const current = fs.readFileSync(file, "utf8");
    const formatted = await prettier.format(current.replace(/^\uFEFF/, ""), {
      ...config,
      filepath: file,
    });
    if (current === formatted) continue;
    if (write) fs.writeFileSync(file, formatted, "utf8");
    else {
      console.error(`[FORMAT] ${relative}`);
      stale++;
    }
  }
  console.log(
    `[FORMAT] ${files.length} authored files ${write ? "formatted" : "checked"}; ${stale} stale.`,
  );
  if (stale) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
