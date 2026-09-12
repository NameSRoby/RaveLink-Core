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
    const modsRoot = path.resolve(options.modsRoot || path.join(runtimeRoot, "installed"));
    const inboxRoot = path.resolve(options.inboxRoot || path.join(rootDir, "mod"));
    const approvalStore = createModApprovalStore({ storePath: path.join(runtimeRoot, "approvals.json") });
    const registry = createModHostRegistry({
      modsRoot,
      runtimeRoot,
      approvalStore,
      maxActiveMods: options.maxActiveMods,
      egressGovernor: context.egressGovernor,
      resourceMonitorOptions: options.resourceMonitorOptions
    });
    const packageManager = createModPackageManager({
      modsRoot,
      runtimeRoot,
      approvalStore,
      isModActive: modId => registry.list().mods.some(row => row.id === modId && row.enabled)
    });
    const inbox = createModDropInbox({ inboxRoot, packageManager, log: options.log || console });
    registry.discover();
    void inbox.start();
    const routes = registerModPlatformRoutes(context.app, {
      express: context.express,
      registry,
      packageManager,
      inbox,
      uploadRoot: path.join(runtimeRoot, "uploads")
    });
    return Object.freeze({
      owner: "mod-platform",
      registry,
      packageManager,
      inbox,
      routes,
      async shutdown() {
        await inbox.shutdown();
        return registry.shutdown();
      }
    });
  };
};
