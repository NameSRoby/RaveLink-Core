// [TITLE] Module: capabilities/supervised-runtime/host/process-permissions.js
// [TITLE] Purpose: build fail-closed Node permission flags for a supervised process
// [TITLE] Functionality Index:
// [TITLE] - detect whether the current Node runtime can restrict network access
// [TITLE] - grant package reads and explicitly approved process spawning only
// [TITLE] - require an explicit developer override when isolation is incomplete

const path = require("node:path");

function hasFlag(flags, name) {
  if (!flags || typeof flags.has !== "function") return false;
  return flags.has(name) || flags.has(`${name}=`);
}

function detectPermissionSupport(flags = process.allowedNodeEnvironmentFlags) {
  return Object.freeze({
    permission: hasFlag(flags, "--permission"),
    fsRead: hasFlag(flags, "--allow-fs-read"),
    fsWrite: hasFlag(flags, "--allow-fs-write"),
    network: hasFlag(flags, "--allow-net"),
    childProcess: hasFlag(flags, "--allow-child-process"),
    worker: hasFlag(flags, "--allow-worker"),
    addons: hasFlag(flags, "--allow-addons")
  });
}

function buildProcessPermissions(options = {}) {
  const manifest = options.manifest || {};
  const permissions = manifest.permissions || {};
  const support = options.support || detectPermissionSupport(options.allowedFlags);
  const allowUnsafeRuntime = options.allowUnsafeRuntime === true;
  const modRoot = path.resolve(String(options.modRoot || ""));
  const platformRoot = path.resolve(String(options.platformRoot || path.join(__dirname, "..")));
  const missing = [];
  if (!support.permission) missing.push("permission_model");
  if (!support.fsRead) missing.push("filesystem_read_policy");
  if (!support.network) missing.push("network_policy");
  if (permissions.process === true && !support.childProcess) missing.push("child_process_policy");

  if (missing.length && !allowUnsafeRuntime) {
    return {
      ok: false,
      code: "runtime_isolation_unavailable",
      missing,
      support,
      execArgv: [],
      unsafe: false
    };
  }

  const execArgv = [];
  if (support.permission) {
    execArgv.push("--permission");
    if (support.fsRead) {
      execArgv.push(`--allow-fs-read=${platformRoot}`);
      execArgv.push(`--allow-fs-read=${modRoot}`);
      for (const readRoot of options.additionalReadRoots || []) {
        execArgv.push(`--allow-fs-read=${path.resolve(String(readRoot))}`);
      }
    }
    if (permissions.process === true && support.childProcess) execArgv.push("--allow-child-process");
  }
  return {
    ok: true,
    code: missing.length ? "unsafe_developer_override" : "enforced",
    missing,
    support,
    execArgv,
    unsafe: missing.length > 0
  };
}

module.exports = {
  buildProcessPermissions,
  detectPermissionSupport
};
