/**
 * Deterministic assembly of self-contained feature pages.
 *
 * Feature panels execute in sandboxed frames, so their CSS/JS is embedded into
 * HTML. The small source files remain authoritative. Reject missing, duplicate,
 * or reversed markers: silently succeeding would ship an old bundle while tests
 * exercise newer source. Check mode computes the exact same bytes without writes.
 */
const fs = require("node:fs");

const normalize = (text) => String(text).replace(/\r\n?/g, "\n");
const read = (file) => normalize(fs.readFileSync(file, "utf8"));

function replaceBlock(content, start, end, replacement) {
  const first = content.indexOf(start);
  const last = content.indexOf(end);
  if (
    first < 0 ||
    last < first + start.length ||
    content.indexOf(start, first + start.length) !== -1 ||
    content.indexOf(end, last + end.length) !== -1
  ) {
    throw new Error(`Expected one ordered embedded block: ${start}`);
  }
  return content.slice(0, first) + start + replacement + end + content.slice(last + end.length);
}

function syncFile(file, transform, options = {}) {
  const current = read(file);
  const next = normalize(transform(current));
  if (options.check) {
    if (next !== current) throw new Error(`Generated page is stale: ${file}`);
  } else if (next !== current) {
    fs.writeFileSync(file, next, "utf8");
  }
}

module.exports = { read, replaceBlock, syncFile };
