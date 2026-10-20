/** Exclusive effect ownership of a bridge stream, separate from fixture leases. */
module.exports = function createEntertainmentOwnership({
  hueEntertainment,
  dryRun,
  forceHttp,
  getMode,
  fixtureSupportsHueEntertainment,
}) {
  const entertainmentOwners = new Map();
  async function stopEntertainment(owner) {
    const rows = entertainmentOwners.get(owner) || [];
    entertainmentOwners.delete(owner);
    await Promise.all(rows.map((f) => hueEntertainment.stopConfig?.(f)));
  }
  async function prepareEntertainment(fixtures = [], owner = "standalone") {
    const activeIds = [];
    await stopEntertainment(owner);
    if (entertainmentOwners.size >= 64)
      return { ok: false, error: "hue_entertainment_owner_limit" };
    entertainmentOwners.set(owner, []);
    for (const fixture of fixtures.filter((f) => f.brand === "hue")) {
      if (!fixture.clientKey || !fixture.entertainmentAreaId || getMode() === "rest") continue;
      if (
        [...entertainmentOwners.entries()].some(
          ([other, rows]) => other !== owner && rows.some((f) => f.bridgeIp === fixture.bridgeIp),
        )
      ) {
        await stopEntertainment(owner);
        return { ok: false, error: "hue_entertainment_bridge_busy" };
      }
      entertainmentOwners.get(owner).push(fixture);
      if (dryRun) {
        activeIds.push(fixture.id);
        continue;
      }
      const result = await hueEntertainment.ensureSession({
        ...fixture,
        forceHttp: forceHttp(fixture),
      });
      if (!result.ok) {
        await stopEntertainment(owner);
        return { ok: false, error: result.error };
      }
      // Every selected light must have an independently addressable channel.
      if (
        result.session &&
        !result.session.channels.some(
          (ch) => ch.lights.length === 1 && ch.lights[0] === String(fixture.lightId),
        )
      ) {
        await stopEntertainment(owner);
        return { ok: false, error: "hue_entertainment_channel_not_addressable" };
      }
      activeIds.push(fixture.id);
    }
    return { ok: true, activeIds };
  }

  function evaluateEntertainmentReadiness(fixtures = []) {
    const rows = Array.isArray(fixtures) ? fixtures : [];
    const hueRows = rows.filter(
      (row) =>
        String(row?.brand || "")
          .trim()
          .toLowerCase() === "hue",
    );
    const entertainmentCapableRows = hueRows.filter((row) => fixtureSupportsHueEntertainment(row));
    const readyRows = hueRows.filter((row) => {
      if (!fixtureSupportsHueEntertainment(row)) return false;
      const bridgeIp = String(row?.bridgeIp || "").trim();
      const username = String(row?.username || "").trim();
      const clientKey = String(row?.clientKey || "").trim();
      const entertainmentAreaId = String(row?.entertainmentAreaId || "").trim();
      return Boolean(bridgeIp && username && clientKey && entertainmentAreaId);
    });
    return {
      fixtureTotalCount: entertainmentCapableRows.length,
      fixtureReadyCount: readyRows.length,
    };
  }

  return { prepareEntertainment, stopEntertainment, evaluateEntertainmentReadiness };
};
