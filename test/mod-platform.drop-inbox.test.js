const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createModApprovalStore = require("../src/capabilities/mod-platform/packages/mod-approval-store");
const createModPackageManager = require("../src/capabilities/mod-platform/packages/mod-package-manager");
const createModDropInbox = require("../src/capabilities/mod-platform/packages/mod-drop-inbox");
const { createPackage } = require("./helpers/mod-package-fixture");

test("drop inbox discovers verified folders without executing their entry", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-drop-inbox-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const inboxRoot = path.join(root, "mod");
  const runtimeRoot = path.join(root, "runtime");
  const marker = path.join(root, "executed.txt");
  const source = path.join(inboxRoot, "sample");
  await createPackage(source, {
    source: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad"); module.exports = {};\n`,
  });
  const approvalStore = createModApprovalStore({
    storePath: path.join(runtimeRoot, "approvals.json"),
  });
  const packageManager = createModPackageManager({
    modsRoot: path.join(runtimeRoot, "installed"),
    runtimeRoot,
    approvalStore,
  });
  const inbox = createModDropInbox({ inboxRoot, packageManager });
  t.after(() => inbox.shutdown());

  const snapshot = await inbox.scan();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.candidates[0].valid, true);
  assert.equal(snapshot.candidates[0].id, "example.package-mod");
  assert.equal(snapshot.candidates[0].fingerprint.length, 64);
  assert.equal(fs.existsSync(marker), false);
});

test("drop inbox watcher emits a verified candidate after a package is copied", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-drop-watch-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const inboxRoot = path.join(root, "mod");
  const runtimeRoot = path.join(root, "runtime");
  const approvalStore = createModApprovalStore({
    storePath: path.join(runtimeRoot, "approvals.json"),
  });
  const packageManager = createModPackageManager({
    modsRoot: path.join(runtimeRoot, "installed"),
    runtimeRoot,
    approvalStore,
  });
  const inbox = createModDropInbox({ inboxRoot, packageManager });
  await inbox.start();
  t.after(() => inbox.shutdown());
  const detected = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("drop_inbox_detection_timeout")), 3000);
    const unsubscribe = inbox.subscribe((snapshot) => {
      if (snapshot.candidates.some((row) => row.valid && row.id === "example.package-mod")) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      }
    });
  });

  await createPackage(path.join(inboxRoot, "copied-package"));
  const snapshot = await detected;
  assert.equal(snapshot.total, 1);
});

test("mods is canonical while legacy drops remain distinct and are never executed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mods-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const packageManager = createModPackageManager({
    modsRoot: path.join(runtimeRoot, "installed"),
    runtimeRoot,
  });
  const inbox = createModDropInbox({
    inboxRoot: path.join(root, "mods"),
    legacyInboxRoot: path.join(root, "mod"),
    packageManager,
  });
  t.after(() => inbox.shutdown());
  for (const name of ["mods", "mod"]) await createPackage(path.join(root, name, "same-name"));
  const result = await inbox.scan();
  assert.equal(result.inbox, "mods");
  assert.equal(result.total, 2);
  assert.equal(new Set(result.candidates.map((c) => c.candidateId)).size, 2);
  assert(result.candidates.every((c) => c.valid));
  assert(!fs.existsSync(path.join(runtimeRoot, "installed")));
});
