/** Native lighting service. Construction starts no capture or output work.
 * Core's lifecycle drains this owner before its shared fixture broker/transports.
 * Operator preferences are private runtime data. Restoration starts no capture.
 */
const createController = require("../../../integrations/music-to-light/controller.cjs");
const probe = require("../../../integrations/music-to-light/probe.cjs");
const fs = require("node:fs"),
  path = require("node:path");
const { settings } = require("../../../integrations/music-to-light/mapping-settings.cjs");
const fault = (code) => Object.assign(new Error(code), { code });
module.exports = function createMusicToLightService({
  core,
  controllerOptions = {},
  designPath,
  operatorPath,
  readPlayback,
} = {}) {
  let saved,
    designRecovered = false;
  if (designPath && fs.existsSync(designPath)) {
    try {
      const stat = fs.lstatSync(designPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
        throw Error("invalid_design");
      saved = settings(JSON.parse(fs.readFileSync(designPath, "utf8")));
    } catch {
      designRecovered = true;
    }
  }
  const fixtures = () =>
    (core?.fixtureRegistry.listConfigured?.() || core?.fixtureRegistry.getFixtures() || [])
      .filter((f) => f.enabled !== false && ["hue", "wiz"].includes(f.brand))
      .map((f) => ({
        id: f.id,
        name: String(f.name || f.id).slice(0, 80),
        brand: f.brand,
        enabled: true,
      }));
  const appSources =
    controllerOptions.probeApi ||
    require("../../../integrations/music-to-light/application-sources.cjs")({ native: probe });
  const savedEffects = require("../../../integrations/music-to-light/saved-effects.cjs")({
    storePath: designPath ? path.join(path.dirname(designPath), "saved-effects.json") : undefined,
  });
  const instance = createController({
    savedEffects,
    ...controllerOptions,
    probeApi: appSources,
    readPlayback: readPlayback || controllerOptions.readPlayback,
    initialSettings: controllerOptions.initialSettings || saved,
    output: core
      ? {
          ownership: core.fixtureOutput.ownership,
          prepare: async (selected, owner) => {
            const configured =
              core.fixtureRegistry.listConfigured?.() || core.fixtureRegistry.getFixtures();
            const rows = selected
              .map((f) => configured.find((row) => row.id === f.id))
              .filter(Boolean);
            return (
              core.hueBridge?.prepareEntertainment?.(rows, owner) || { ok: true, activeIds: [] }
            );
          },
          stopTransport: (owner) => core.hueBridge?.stopEntertainment?.(owner),
          resolveFixtures: fixtures,
          isRaveAllowed: core.twitchLightEffects
            ? (id) => {
                const policy = core.twitchLightEffects.snapshot();
                return (
                  policy.enabled &&
                  policy.fixtureIds.includes(id) &&
                  !core.lightingLab?.isExcluded(id)
                );
              }
            : undefined,
        }
      : null,
  });
  instance.operator.activate();
  let operatorRecovered = false;
  if (operatorPath && fs.existsSync(operatorPath)) {
    try {
      const stat = fs.lstatSync(operatorPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
        throw Error("invalid_operator_file");
      const value = JSON.parse(fs.readFileSync(operatorPath, "utf8"));
      if (
        value.version !== 1 ||
        Object.keys(value).some(
          (k) => !["version", "source", "sources", "permissions", "fixtures"].includes(k),
        )
      )
        throw Error("invalid_operator_file");
      const source = value.source == null ? null : appSources.remember(value.source);
      if (
        value.sources !== undefined &&
        (!Array.isArray(value.sources) || value.sources.length !== 3)
      )
        throw Error("invalid_operator_file");
      const sources =
        value.sources === undefined
          ? [source, null, null]
          : value.sources.map((row) => (row === null ? null : appSources.remember(row)));
      const restored = {
        permissions: value.permissions,
        source,
        sources,
        fixtures: value.fixtures,
      };
      try {
        instance.operator.restore(restored);
      } catch (error) {
        // A removed/disabled fixture must not discard an independently valid
        // remembered app and its grants. Re-select lights without losing music.
        // Malformed rows/files are different: do not recover grants from them.
        if (
          !Array.isArray(value.fixtures) ||
          !["music_fixture_not_available", "music_output_unavailable"].includes(error.code)
        )
          throw error;
        instance.operator.restore({ ...restored, fixtures: [] });
        operatorRecovered = true;
      }
    } catch {
      operatorRecovered = true;
    }
  }
  function saveOperator() {
    if (!operatorPath) return;
    const bindings = instance.operator.bindings();
    const selected = bindings.source ? appSources.describe?.(bindings.source.id) : null;
    const data = {
      version: 1,
      source: selected,
      sources: bindings.sources.map((row) => (row ? appSources.describe?.(row.id) : null)),
      permissions: instance.client.status().permissions,
      fixtures: bindings.fixtures,
    };
    fs.mkdirSync(path.dirname(operatorPath), { recursive: true });
    fs.writeFileSync(operatorPath + ".tmp", JSON.stringify(data) + "\n", { mode: 0o600 });
    fs.renameSync(operatorPath + ".tmp", operatorPath);
    operatorRecovered = false;
  }
  const operatorChange = (method) => async (value) => {
    await instance.operator[method](value);
    try {
      saveOperator();
    } catch {
      throw fault("music_operator_save_failed");
    }
  };
  return Object.freeze({
    effects: () => savedEffects.snapshot(),
    saveEffect: (value) => {
      const status = instance.client.status();
      const pipeline = instance.operator.pipeline();
      if (pipeline)
        pipeline.assignments = (pipeline.assignments || []).map((a) => ({
          ...instance.operator.bindings().fixtures.find((f) => f.id === a.id),
          ...a,
        }));
      return savedEffects.save(value, pipeline, status.session?.transition);
    },
    effectPolicy: (value) => savedEffects.policy(value),
    deleteEffect: (id) => savedEffects.remove(id),
    async call(payload) {
      if (
        !payload ||
        Object.keys(payload).some((k) => !["capability", "method", "payload"].includes(k))
      )
        throw fault("invalid_music_request");
      const previous = instance.client.exportDesign();
      const result = await instance.client.call(
        payload.capability,
        payload.method,
        payload.payload,
      );
      if (
        designPath &&
        payload.capability === "music.styles.v1" &&
        ["configure", "calibrate"].includes(payload.method)
      ) {
        try {
          fs.mkdirSync(path.dirname(designPath), { recursive: true });
          fs.writeFileSync(designPath + ".tmp", JSON.stringify(settings(result)) + "\n", {
            mode: 0o600,
          });
          fs.renameSync(designPath + ".tmp", designPath);
          designRecovered = false;
        } catch {
          instance.client.configure(previous);
          throw fault("music_design_save_failed");
        }
      }
      // Native enumeration has a larger bound. Reject before broker framing,
      // rather than crash/quarantine a worker on an unusually large catalog.
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 50000)
        throw fault("music_response_too_large");
      return result;
    },
    view() {
      return {
        status: instance.client.status(),
        design: instance.client.exportDesign(),
        bindings: instance.operator.bindings(),
        fixtures: fixtures(),
        captureAvailable: appSources.available?.() ?? false,
        designRecovered,
        operatorRecovered,
        sourceResolution: appSources.resolution?.() || null,
      };
    },
    permissions: operatorChange("permissions"),
    pipeline: () => instance.operator.pipeline(),
    rave: (value) => instance.operator.rave(value),
    checkRave: (value) => instance.operator.checkRave(value),
    stopRave: (ids) => instance.operator.stopRave(ids),
    raveIds: () => instance.operator.raveIds(),
    source: operatorChange("selectSource"),
    sources: operatorChange("selectSources"),
    fixtures: operatorChange("selectFixtures"),
    shutdown: () => instance.operator.shutdown(),
  });
};
