const fs = require("node:fs");
const path = require("node:path");
const {
  hashFileSha256,
} = require("../../src/capabilities/mod-platform/packages/mod-package-integrity");

async function createPackage(root, options = {}) {
  await fs.promises.mkdir(path.join(root, "dist"), { recursive: true });
  const source = options.source || "module.exports = {};\n";
  await fs.promises.writeFile(path.join(root, "dist", "main.js"), source, "utf8");
  const hash = await hashFileSha256(path.join(root, "dist", "main.js"));
  const manifest = {
    schemaVersion: 1,
    id: options.id || "example.package-mod",
    name: "Package Mod",
    version: options.version || "1.0.0",
    publisher: "example",
    license: "MIT",
    entry: "dist/main.js",
    engine: { ravelinkModApi: "^1.0.0", node: ">=22" },
    activationEvents: ["onEnable"],
    consumes: [],
    provides: ["example.service.v1"],
    permissions: options.permissions || {},
    resources: {
      idleCpuPercent: 0.1,
      idleRssMiB: 32,
      activeRssMiB: 64,
      timers: 1,
      minTimerMs: 1000,
      ipcFrameBytes: 32768,
      inFlightCalls: 1,
      queuedCalls: 1,
      externalInFlight: 0,
      storageBytes: 1024,
      historyEntries: 10,
      shutdownGraceMs: 500,
      ...(options.resources || {}),
    },
    integrity: {
      algorithm: "sha256",
      files: { "dist/main.js": options.hash || hash },
    },
  };
  await fs.promises.writeFile(
    path.join(root, "ravelink.mod.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

module.exports = { createPackage };
