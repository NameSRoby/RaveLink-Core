/** App selection is private operator state, never a portable lighting design.
 * Reconstructing Core must be inert, including when the selected player is shut.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const createHost = require("../src/domains/music-to-light/music-to-light.service");
const createApps = require("../integrations/music-to-light/application-sources.cjs");

test("Core remembers app, grants and lights without capture; next Start resolves the new process", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-app-selection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const operatorPath = path.join(dir, "operator.json");
  let pid = 10,
    queries = 0;
  const captures = [];
  const native = {
    available: () => true,
    applicationCatalog: async () => {
      queries++;
      return {
        sources: [
          {
            id: `process:${pid}:100`,
            label: "music.exe",
            kind: "application",
            scope: "process_tree",
            active: true,
          },
        ],
        processes: [
          { pid, parent: 0, created: "100", image: "C:\\ExamplePlayer\\music.exe", package: "" },
        ],
      };
    },
    capture(id) {
      captures.push(id);
      let finish;
      return {
        events: new EventEmitter(),
        done: new Promise((r) => {
          finish = r;
        }),
        stop: () => finish({ reason: "parent_stop" }),
        snapshot: () => ({ generation: "a".repeat(32), state: "ready" }),
      };
    },
  };
  const core = {
    fixtureRegistry: {
      getFixtures: () => [{ id: "example", name: "Example", brand: "hue", enabled: true }],
    },
    fixtureOutput: { ownership: {} },
  };
  const make = () =>
    createHost({ core, operatorPath, controllerOptions: { probeApi: createApps({ native }) } });
  let host = make();
  await host.permissions({ capture: true, output: true });
  const [source] = await host.call({ capability: "music.sources.v1", method: "list" });
  await host.source(source.id);
  await host.fixtures([{ id: "example", role: "low", position: 0 }]);
  const stored = JSON.parse(fs.readFileSync(operatorPath));
  assert.equal(stored.source.identity.image, "c:\\exampleplayer\\music.exe");
  assert.ok(!JSON.stringify(stored).includes("process:10:"));
  await host.shutdown();
  pid = 20;
  queries = 0;
  host = make();
  t.after(() => host.shutdown());
  assert.equal(queries, 0);
  assert.equal(captures.length, 0);
  assert.equal(host.view().status.sourceSelected, true);
  assert.deepEqual(host.view().status.permissions, { capture: true, output: true });
  assert.equal(host.view().bindings.fixtures[0].id, "example");
  assert.ok(!JSON.stringify(host.view()).includes("ExamplePlayer"));
  await host.call({
    capability: "music.session.v1",
    method: "start",
    payload: { mode: "preview", seconds: 5 },
  });
  await new Promise(setImmediate);
  assert.deepEqual(captures, ["process:20:100"]);
  await host.call({ capability: "music.session.v1", method: "stop" });
  await host.permissions({ capture: false, output: false });
  assert.equal(host.view().status.sourceSelected, true);
  await host.source(null);
  assert.equal(host.view().status.sourceSelected, false);
  assert.equal(JSON.parse(fs.readFileSync(operatorPath)).source, null);
});

test("corrupt operator settings recover with denied grants and no native query", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-app-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const operatorPath = path.join(dir, "operator.json");
  fs.writeFileSync(
    operatorPath,
    '{"version":1,"permissions":{"capture":true,"output":true},"fixtures":"invalid"}',
  );
  const apps = createApps({
    native: { available: () => true, applicationCatalog: () => assert.fail("startup query") },
  });
  const host = createHost({ operatorPath, controllerOptions: { probeApi: apps } });
  t.after(() => host.shutdown());
  assert.equal(host.view().operatorRecovered, true);
  assert.deepEqual(host.view().status.permissions, { capture: false, output: false });
  assert.equal(host.view().status.sourceSelected, false);
});
