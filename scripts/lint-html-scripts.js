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

async function main() {
  const eslint = new ESLint({
    overrideConfig: [{ files: ["**/*.inline.js"], languageOptions: { sourceType: "script" } }],
  });
  let errors = 0;
  let pages = 0;
  for (const relative of sourceFiles().filter((file) => file.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(ROOT, relative), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
      (match) => {
        if (/\bsrc\s*=/i.test(match[1])) return false;
        const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
        return !type || ["module", "text/javascript", "application/javascript"].includes(type);
      },
    );
    if (!scripts.length) continue;
    pages++;
    const [report] = await eslint.lintText(scripts.map((match) => match[2]).join("\n;\n"), {
      filePath: path.join(ROOT, "src", path.basename(relative) + ".inline.js"),
    });
    for (const message of report.messages) {
      console.error(`[INLINE] ${relative}:inline:${message.line}: ${message.message}`);
      errors++;
    }
  }
  console.log(`[INLINE] ${pages} HTML pages checked; ${errors} errors.`);
  if (errors) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
