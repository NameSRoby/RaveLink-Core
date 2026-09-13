const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCoreUpdateService, compareVersions, parseVersion, RELEASE_API } = require("../src/domains/system/core-update.service");

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-update-test-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.6.1" }));
  return root;
}

test("strict semantic release versions compare without prerelease ambiguity", () => {
  assert.deepEqual(parseVersion("v0.6.2"), [0, 6, 2]);
  assert.equal(parseVersion("0.6.2-beta"), null);
  assert.equal(compareVersions("0.6.1", "0.6.2"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.99"), 1);
});

test("release checks remain opt-in and expose only bounded public status", async t => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let requests = 0;
  const archive = Buffer.from("controlled release archive");
  const archiveName = "RaveLink-Core-Windows-v0.6.2-self-contained.zip";
  const checksum = crypto.createHash("sha256").update(archive).digest("hex");
  const fakeFetch = async url => {
    requests++;
    if (url === RELEASE_API) return new Response(JSON.stringify({
      tag_name: "v0.6.2", name: "RaveLink Core v0.6.2", draft: false, prerelease: false,
      published_at: "2026-09-12T00:00:00Z",
      assets: [
        { name: archiveName, size: archive.length, browser_download_url: `https://github.com/NameSRoby/RaveLink-Core/releases/download/v0.6.2/${archiveName}` },
        { name: "SHA256SUMS.txt", size: 100, browser_download_url: "https://github.com/NameSRoby/RaveLink-Core/releases/download/v0.6.2/SHA256SUMS.txt" }
      ]
    }), { status: 200 });
    if (String(url).endsWith("SHA256SUMS.txt")) return new Response(`${checksum}  ${archiveName}\n`, { status: 200 });
    if (String(url).endsWith(archiveName)) return new Response(archive, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  const service = createCoreUpdateService({ rootDir: root, runtimeDir: path.join(root, "runtime"), fetch: fakeFetch, launchDelayMs: 1 });
  service.startLaunchCheck();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 0);
  assert.equal(service.status().checkOnLaunch, false);

  service.configure({ checkOnLaunch: true });
  const checked = await service.check();
  assert.equal(checked.latest.version, "0.6.2");
  assert.equal(checked.latest.available, true);
  assert.equal("archivePath" in checked, false);

  const staged = await service.download();
  assert.deepEqual(staged.staged, { version: "0.6.2", verified: true });
  const internal = JSON.parse(fs.readFileSync(path.join(root, "runtime", "updates", "staged.json"), "utf8"));
  assert.equal(fs.readFileSync(internal.archivePath).toString(), archive.toString());
  assert.equal(internal.sha256, checksum);
});

test("release metadata rejects assets outside the fixed GitHub repository", async t => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createCoreUpdateService({ rootDir: root, fetch: async () => new Response(JSON.stringify({
    tag_name: "v0.6.2", draft: false, prerelease: false,
    assets: [
      { name: "RaveLink-Core-Windows-v0.6.2-self-contained.zip", browser_download_url: "https://example.com/update.zip" },
      { name: "SHA256SUMS.txt", browser_download_url: "https://example.com/SHA256SUMS.txt" }
    ]
  }), { status: 200 }) });
  await assert.rejects(service.check(), /release_asset_origin_invalid/);
});
