/** Bounded Hue area inventory shared by pairing and saved-fixture setup. */
const clampNumber = require("../../shared/validation/clamp-number");
module.exports = function createAreaDiscovery({ axios, sanitizeBridgeHost, sanitizeUsername }) {
  return async function listEntertainmentAreas(bridgeHost = "", username = "", input = {}) {
    const host = sanitizeBridgeHost(bridgeHost);
    const user = sanitizeUsername(username);
    if (!host || !user || !axios || typeof axios.get !== "function") {
      if (input.strict)
        throw Object.assign(Error("hue_pairing_required"), { code: "hue_pairing_required" });
      return [];
    }
    try {
      const response = await axios.get(`http://${host}/api/${user}/groups`, {
        timeout: clampNumber(input.timeoutMs, 200, 10000, 2000),
        maxRedirects: 0,
        maxContentLength: 256 * 1024,
      });
      const groups = response?.data;
      if (!groups || typeof groups !== "object" || Array.isArray(groups) || groups.errors?.length)
        throw Error("bridge_rejected");
      const out = [];
      for (const [id, row] of Object.entries(groups).slice(0, 256)) {
        const type = String(row?.type || "")
          .trim()
          .toLowerCase();
        if (type !== "entertainment") continue;
        const areaId = String(id || "").trim();
        if (!/^[1-9]\d{0,9}$/.test(areaId)) continue;
        out.push({
          id: areaId,
          name: (String(row?.name || areaId).trim() || areaId).slice(0, 96),
          ...(input.strict
            ? {
                lightIds: (Array.isArray(row.lights) ? row.lights : [])
                  .slice(0, 64)
                  .map(String)
                  .filter((id) => /^[1-9]\d{0,4}$/.test(id)),
                active: row.stream?.active === true,
              }
            : {}),
        });
      }
      return out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    } catch {
      if (input.strict)
        throw Object.assign(Error("hue_area_discovery_failed"), {
          code: "hue_area_discovery_failed",
        });
      return [];
    }
  };
};
