const test = require("node:test");
const assert = require("node:assert/strict");
const scripts = require("../scripts/lib/html-scripts");

test("HTML lint extraction follows permissive end tags, quoted attributes, data and module scopes", async () => {
  const extracted = await scripts(`
    <script data-value=">">first()</script >
    <script src="external.js">externalBody()</script>
    <script type="application/json">{"data":true}</script>
    <template><script>inert()</script></template>
    <script TYPE="module">export const value = 1;</script>
  `);
  assert.deepEqual(extracted, [
    { code: "first()", module: false },
    { code: "export const value = 1;", module: true },
  ]);
});
