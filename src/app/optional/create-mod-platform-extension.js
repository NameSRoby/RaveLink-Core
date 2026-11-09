// [TITLE] Module: app/optional/create-mod-platform-extension.js
// [TITLE] Purpose: opt-in composition of the independent core and third-party mod host

const path = require("node:path");
const createModApprovalStore = require("../../capabilities/mod-platform/packages/mod-approval-store");
const createModPackageManager = require("../../capabilities/mod-platform/packages/mod-package-manager");
const createModDropInbox = require("../../capabilities/mod-platform/packages/mod-drop-inbox");
const createModHostRegistry = require("../../capabilities/mod-platform/host/mod-host-registry");
const registerModPlatformRoutes = require("../../capabilities/mod-platform/http/register-mod-platform.routes");

module.exports = function createModPlatformExtension(options = {}) {
  return function attachModPlatform(context) {
    const rootDir = path.resolve(options.rootDir || context.rootDir);
    const runtimeRoot = path.resolve(options.runtimeRoot || path.join(context.runtimeDir, "mods"));
    const modsRoot = path.resolve(
      options.modsRoot ||
        path.join(runtimeRoot, options.bundledOnly ? "bundled-installed" : "installed"),
    );
    const inboxRoot = path.resolve(options.inboxRoot || path.join(rootDir, "mods"));
    const approvalStore = createModApprovalStore({
      storePath: path.join(runtimeRoot, "approvals.json"),
    });
    const bundled = require("../../capabilities/mod-platform/packages/bundled-mods")({
      rootDir,
      modsRoot,
      runtimeRoot,
      approvalStore,
    });
    const registry = createModHostRegistry({
      modsRoot,
      runtimeRoot,
      approvalStore,
      maxActiveMods: options.maxActiveMods,
      egressGovernor: context.egressGovernor,
      resourceMonitorOptions: options.resourceMonitorOptions,
      onEnabledPreference: bundled.preference,
      allowedModIds: options.bundledOnly ? ["ravelink.twitch-clips"] : undefined,
    });
    require("../../capabilities/mod-platform/host/mod-twitch-clips-provider")(registry, {
      getTwitchClips: context.getTwitchClips,
    });
    require("../../capabilities/mod-platform/host/mod-app-controls")(
      registry,
      context.controlDeckActions,
    );
    const packageManager = createModPackageManager({
      modsRoot,
      runtimeRoot,
      approvalStore,
      isModActive: (modId) => registry.list().mods.some((row) => row.id === modId && row.enabled),
    });
    const inbox = createModDropInbox({
      inboxRoot,
      legacyInboxRoot: options.inboxRoot ? undefined : path.join(rootDir, "mod"),
      packageManager,
      log: options.log || console,
    });
    registry.discover();
    let closing = false;
    const startup = bundled
      .prepare()
      .then(async (result) => {
        if (closing) return result;
        registry.discover();
        result.activations = [];
        for (const id of result.enable) {
          if (closing) break;
          // These exact, inventory-verified adapters are application-owned code.
          // Community mods never inherit this first-party runtime exception.
          result.activations.push(await registry.enable(id, { allowUnsafeRuntime: true }));
        }
        return result;
      })
      .catch(() => ({ enable: [], results: [{ ok: false, code: "bundled_mod_setup_failed" }] }));
    if (!options.bundledOnly)
      inbox
        .start()
        .catch((error) =>
          (options.log || console).warn?.(
            `[MOD INBOX] startup unavailable: ${error?.message || error}`,
          ),
        );
    const routes = registerModPlatformRoutes(context.app, {
      express: context.express,
      registry,
      packageManager,
      inbox,
      uploadRoot: path.join(runtimeRoot, "uploads"),
      bundledOnly: options.bundledOnly === true,
    });
    return Object.freeze({
      owner: "mod-platform",
      registry,
      packageManager,
      inbox,
      routes,
      startup,
      async shutdown() {
        closing = true;
        await startup;
        await inbox.shutdown();
        return registry.shutdown();
      },
    });
  };
};
