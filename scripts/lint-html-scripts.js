/**
 * Apply correctness rules to executable scripts embedded in feature/HUD HTML.
 * Classic scripts share a page's global environment, so lint them together;
 * linting fragments separately would misidentify cross-script calls as dead code.
 * Non-executable data scripts and external src tags are excluded. Messages report
 * the combined inline-script line, explicitly distinguished from the HTML line.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ESLint } = require("eslint");
const { ROOT, sourceFiles } = require("./lib/source-inventory");
const htmlScripts = require("./lib/html-scripts");

async function main() {
  const eslint = new ESLint({
    overrideConfig: [{ files: ["**/*.inline.js"], languageOptions: { sourceType: "script" } }],
  });
  const moduleEslint = new ESLint({
    overrideConfig: [{ files: ["**/*.inline.js"], languageOptions: { sourceType: "module" } }],
  });
  let errors = 0;
  let pages = 0;
  for (const relative of sourceFiles().filter((file) => file.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(ROOT, relative), "utf8");
    const scripts = await htmlScripts(html);
    if (!scripts.length) continue;
    pages++;
    // Classic tags share globals; each module tag has its own lexical scope.
    const classic = scripts
      .filter((script) => !script.module)
      .map((script) => script.code)
      .join("\n;\n");
    const groups = [
      ...(classic ? [{ code: classic, module: false }] : []),
      ...scripts.filter((script) => script.module),
    ];
    for (const group of groups) {
      const [report] = await (group.module ? moduleEslint : eslint).lintText(group.code, {
        filePath: path.join(ROOT, "src", path.basename(relative) + ".inline.js"),
      });
      for (const message of report.messages) {
        console.error(`[INLINE] ${relative}:inline:${message.line}: ${message.message}`);
        errors++;
      }
    }
  }
  console.log(`[INLINE] ${pages} HTML pages checked; ${errors} errors.`);
  if (errors) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
