// [TITLE] Module: app/core/create-lighting-core.js
// [TITLE] Purpose: compose the independently runnable RaveLink lighting core
// [TITLE] Functionality Index:
// [TITLE] - custom color library and human directive parser
// [TITLE] - fixture registry and Hue/WiZ output adapters
// [TITLE] - Twitch color configuration and engine-independent command routing

const createColorLibraryService = require("../../domains/colors/color-library.service");
const createFixtureRegistry = require("../../domains/fixtures/fixture-registry");
const createTwitchColorConfigRuntime = require("../../domains/twitch/twitch-color-config.runtime");
const createTwitchColorDirectiveService = require("../../domains/twitch/twitch-color-directive");
const createColorCommandService = require("../../domains/twitch/color-command.service");
const createHueBridgeAdapter = require("../../adapters/brands/hue-bridge.adapter");
const createWizBridgeAdapter = require("../../adapters/brands/wiz-bridge.adapter");
const createGoveeLanAdapter = require("../../adapters/brands/govee-lan.adapter");
const colorSeedDefault = require("../../domains/colors/color-library.seed.json");
const fixtureSeedDefault = require("../../domains/fixtures/fixtures.seed.json");
const createFixtureSecretVault = require("../../domains/fixtures/fixture-secret-vault");
const createTwitchLightRouting = require('../../domains/twitch/twitch-light-routing');
const path = require('node:path');
const fs = require('node:fs');

const TWITCH_COLOR_CONFIG_DEFAULT = Object.freeze({
  version: 1,
  defaultTarget: "hue",
  autoDefaultTarget: true,
  prefixes: Object.freeze({
    hue: "",
    wiz: "wiz",
    govee: "govee",
    other: ""
  }),
  fixturePrefixes: Object.freeze({})
});

module.exports = function createLightingCore(options = {}) {
  const paths = options.paths && typeof options.paths === "object" ? options.paths : {};
  for (const requiredPath of ["colorsStorePath", "fixturesStorePath", "twitchConfigPath"]) {
    if (!String(paths[requiredPath] || "").trim()) {
      throw new Error(`createLightingCore requires paths.${requiredPath}`);
    }
  }

  const colorLibrary = createColorLibraryService({
    storePath: paths.colorsStorePath,
    seedCustomColors: options.colorSeed || colorSeedDefault,
    fuzzyMinScore: 180
  });
  const fixtureSecretVault = paths.fixtureSecretsVaultPath ? createFixtureSecretVault({
    vaultPath: paths.fixtureSecretsVaultPath,
    ...(options.fixtureSecretVaultOptions || {})
  }) : null;
  const fixtureRegistry = createFixtureRegistry({
    storePath: paths.fixturesStorePath,
    secretVault: fixtureSecretVault,
    seedConfig: options.fixtureSeed || fixtureSeedDefault
  });
  const twitchColorConfig = createTwitchColorConfigRuntime({
    configPath: paths.twitchConfigPath,
    configDefault: options.twitchColorConfigDefault || TWITCH_COLOR_CONFIG_DEFAULT
  });
  const twitchLightRouting = createTwitchLightRouting({ storePath: path.join(path.dirname(paths.twitchConfigPath), 'twitch-light-routing.json'), colorLibrary });
  let routingSnapshot = twitchLightRouting.snapshot();
  const legacyGroupsPath = path.join(path.dirname(paths.fixturesStorePath), "light-groups.json");
  const legacyGroupsArchivePath = `${legacyGroupsPath}.migrated`;
  if (routingSnapshot.ok && fs.existsSync(legacyGroupsPath) && !fs.existsSync(legacyGroupsArchivePath)) {
    try {
      if (fs.statSync(legacyGroupsPath).size > 131072) throw new Error("legacy_groups_too_large");
      if (routingSnapshot.rules.length === 0) {
        const legacy = JSON.parse(fs.readFileSync(legacyGroupsPath, "utf8"));
        const groups = Array.isArray(legacy?.groups) ? legacy.groups.slice(0, 32) : [];
        const rules = groups.filter(row => row && /^[a-zA-Z0-9-]{1,64}$/.test(row.id) && typeof row.name === "string" && Array.isArray(row.fixtureIds) && row.fixtureIds.length <= 64).map(row => ({
          id: row.id,
          name: row.name.trim().slice(0, 64),
          prefix: `group_${row.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 25) || "lights"}`,
          enabled: true,
          fixtureIds: [...new Set(row.fixtureIds.filter(id => typeof id === "string" && id.trim() && id.length <= 256))]
        })).filter(row => row.name && row.fixtureIds.length);
        if (rules.length) routingSnapshot = twitchLightRouting.save({ ...routingSnapshot, mode: "assignments", rules });
      }
      fs.renameSync(legacyGroupsPath, legacyGroupsArchivePath);
    } catch {}
  }
  if (routingSnapshot.ok && routingSnapshot.mode === "legacy") {
    const upgradedRouting = twitchLightRouting.save({ ...routingSnapshot, mode: "assignments" });
    if (upgradedRouting.ok) routingSnapshot = upgradedRouting;
  }
  const directiveService = createTwitchColorDirectiveService({
    colorLibrary,
    getParserOptions: twitchLightRouting.parserOptions,
    sanitizeText: twitchColorConfig.sanitizeCommandText
  });
  const hueBridge = createHueBridgeAdapter({
    axios: options.axios,
    dryRun: options.dryRun === true,
    rootDir: String(options.rootDir || "").trim(),
    egressGovernor: options.egressGovernor,
    log: options.log || console
  });
  const wizBridge = createWizBridgeAdapter({
    dryRun: options.dryRun === true,
    log: options.log || console
  });
  const goveeBridge = createGoveeLanAdapter({ dryRun: options.dryRun === true, log: options.log || console });
  let reconcilePromise = Promise.resolve();
  const reconcileTransports = fixtures => {
    reconcilePromise = reconcilePromise.then(() => Promise.allSettled([
      hueBridge.reconcileFixtures(fixtures),
      Promise.resolve(wizBridge.reconcileFixtures(fixtures)),
      Promise.resolve(goveeBridge.reconcileFixtures(fixtures))
    ]));
    return reconcilePromise;
  };
  const unsubscribeFixtures = fixtureRegistry.subscribe(reconcileTransports);
  void reconcileTransports(fixtureRegistry.getFixtures());
  async function shutdown() {
    unsubscribeFixtures();
    await reconcilePromise;
    await Promise.allSettled([hueBridge.shutdown(), Promise.resolve(wizBridge.shutdown()), Promise.resolve(goveeBridge.shutdown())]);
  }
  const colorCommandService = createColorCommandService({
    twitchColorConfig,
    twitchLightRouting,
    fixtureRegistry,
    fixtureSecretVault,
    directiveService,
    hueBridge,
    wizBridge,
    goveeBridge
  });

  return Object.freeze({
    colorLibrary,
    fixtureRegistry,
    twitchLightRouting,
    twitchColorConfig,
    directiveService,
    colorCommandService,
    hueBridge,
    wizBridge,
    goveeBridge,
    shutdown
  });
};
