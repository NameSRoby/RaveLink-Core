/** Saved-fixture Entertainment setup. Bridge credentials stay server-side. */
const fault = (code) => Object.assign(Error(code), { code });
const validArea = (id) => /^(?:[1-9]\d{0,9}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id);
module.exports = function createHueEntertainmentConfig({
  registry,
  bridge,
  isInUse = () => false,
}) {
  const pending = new Map();
  function fixture(id) {
    const row = registry.getFixtures().find((f) => f.id === id);
    if (!row) throw fault("fixture_not_found");
    if (row.brand !== "hue") throw fault("hue_fixture_required");
    if (!row.bridgeIp || !row.username) throw fault("hue_pairing_required");
    return row;
  }
  async function areas(row) {
    if (!bridge.discoverEntertainmentAreas) throw fault("hue_area_discovery_unavailable");
    const key = row.bridgeIp + "|" + row.username;
    if (!pending.has(key)) {
      if (pending.size >= 4) throw fault("hue_area_discovery_busy");
      const task = Promise.resolve().then(() => bridge.discoverEntertainmentAreas(row));
      pending.set(key, task);
      task.finally(() => pending.delete(key)).catch(() => {});
    }
    const found = await pending.get(key);
    return found.slice(0, 32).map((area) => ({
      id: String(area.id),
      name: String(area.name || area.id).slice(0, 96),
      lightIds: (area.lightIds || []).slice(0, 64).map(String),
      active: area.active === true,
      includesFixture: (area.lightIds || []).map(String).includes(String(row.lightId)),
    }));
  }
  return {
    async discover(id) {
      const row = fixture(id);
      return {
        ok: true,
        areas: await areas(row),
        areaId: row.entertainmentAreaId || "",
        clientKeyConfigured: /^[a-f\d]{32}$/i.test(row.clientKey || ""),
      };
    },
    async save(id, input = {}) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((k) => !["areaId", "clientKey", "applyToAreaLights"].includes(k)) ||
        typeof input.areaId !== "string" ||
        (input.clientKey !== undefined && typeof input.clientKey !== "string") ||
        (input.applyToAreaLights !== undefined && typeof input.applyToAreaLights !== "boolean")
      )
        throw fault("invalid_hue_entertainment_config");
      const areaId = input.areaId.trim().toLowerCase();
      if (areaId && !validArea(areaId)) throw fault("invalid_hue_entertainment_area_id");
      const selected = fixture(id);
      const suppliedKey = (input.clientKey || "").trim();
      if (suppliedKey && !/^[a-f\d]{32}$/i.test(suppliedKey)) throw fault("invalid_hue_client_key");
      if (areaId && !/^[a-f\d]{32}$/i.test(suppliedKey || selected.clientKey || ""))
        throw fault("hue_entertainment_client_key_required");
      let ids = [id];
      if (input.applyToAreaLights) {
        const area = (await areas(selected)).find((a) => a.id === areaId);
        if (!area?.includesFixture) throw fault("hue_entertainment_area_membership_required");
        ids = registry
          .getFixtures()
          .filter(
            (f) =>
              f.brand === "hue" &&
              f.bridgeIp === selected.bridgeIp &&
              f.username === selected.username &&
              area.lightIds.includes(String(f.lightId)),
          )
          .map((f) => f.id);
      }
      // Re-read after discovery: a concurrent edit or removal must not restore
      // stale bridge identity or credentials from the beginning of the request.
      const current = fixture(id);
      if (
        current.bridgeIp !== selected.bridgeIp ||
        current.username !== selected.username ||
        current.clientKey !== selected.clientKey ||
        current.lightId !== selected.lightId
      )
        throw fault("hue_fixture_changed");
      const rows = registry
        .getFixtures()
        .filter(
          (f) =>
            ids.includes(f.id) &&
            f.brand === "hue" &&
            f.bridgeIp === current.bridgeIp &&
            f.username === current.username,
        );
      if (rows.some((f) => isInUse(f.id))) throw fault("hue_entertainment_stop_lights_first");
      const result = registry.upsertFixtures(
        rows.map((f) => ({
          id: f.id,
          entertainmentAreaId: areaId,
          ...(areaId ? { clientKey: suppliedKey || current.clientKey } : {}),
        })),
      );
      if (!result.ok) throw fault(result.error || "hue_entertainment_save_failed");
      return { ok: true, configured: !!areaId, updatedFixtureIds: rows.map((f) => f.id) };
    },
  };
};
