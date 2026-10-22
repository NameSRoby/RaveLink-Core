const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { verify } = require("../scripts/verify-source-runtime");
const { spawnSync } = require("node:child_process");

test("source setup rejects a different runtime graph and missing production dependencies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  const write = (dir, name, data) => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data));
  };
  const lock = {
    packages: {
      "": {},
      "node_modules/required": { version: "1.0.0", integrity: "sha512-example" },
      "node_modules/optional": { version: "1.0.0", optional: true },
      "node_modules/dev": { version: "1.0.0", dev: true },
    },
  };
  write(source, "package-lock.json", lock);
  write(runtime, "package-lock.json", lock);
  for (const name of [
    "runtime/RaveLink-Core-Node.exe",
    "runtime/music-to-light/cargo/release/ravelink-audio-probe.exe",
    "runtime/NODE-LICENSE.txt",
  ])
    write(runtime, name, "fixture");
  assert.throws(() => verify(source, runtime), /ENOENT/);
  write(runtime, "node_modules/required/package.json", { version: "1.0.0" });
  assert.doesNotThrow(() => verify(source, runtime));
  lock.packages["node_modules/required"].integrity = "sha512-different";
  write(runtime, "package-lock.json", lock);
  assert.throws(() => verify(source, runtime), /differs from source lock/);
  lock.packages["node_modules/required"].integrity = "sha512-example";
  write(runtime, "package-lock.json", lock);
  write(runtime, "node_modules/required/package.json", { version: "2.0.0" });
  assert.throws(() => verify(source, runtime), /incompatible/);
});

test(
  "Windows source setup rejects an untrusted offline archive before extracting or running it",
  {
    skip: process.platform !== "win32",
  },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink source setup "));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "scripts"));
    for (const name of ["setup-source.ps1", "source-runtime.json"]) {
      fs.copyFileSync(path.join(__dirname, "../scripts", name), path.join(root, "scripts", name));
    }
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    const archive = path.join(root, "untrusted.zip");
    fs.writeFileSync(archive, "not a release archive");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/setup-source.ps1"),
        "-NoStart",
        "-ReleaseArchive",
        archive,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        env: { ...process.env, PSModulePath: path.join(root, "incompatible-parent-modules") },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /checksum mismatch/);
    assert.equal(fs.existsSync(path.join(root, "runtime/RaveLink-Core-Node.exe")), false);
    assert.equal(fs.existsSync(path.join(root, "RaveLink-Core.exe")), false);
  },
);
