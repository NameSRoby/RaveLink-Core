/** Read a single bulb's restorable state before an effect. Read-only bridge
 * fields (reachability, mode, alerts) must never be sent back as state writes.
 * Preserve the active color mode so a white bulb does not restore as RGB.
 */
module.exports =
  ({ axios, sanitizeBridgeHost, sanitizeUsername }) =>
  async (fixture) => {
    const host = sanitizeBridgeHost(fixture?.bridgeIp),
      user = sanitizeUsername(fixture?.username);
    const id = Number(fixture?.lightId);
    if (!host || !user || !Number.isInteger(id) || id < 1 || id > 65535 || !axios?.get)
      return { ok: false, error: "hue_state_unavailable" };
    try {
      const response = await axios.get(`http://${host}/api/${user}/lights/${id}`, {
        timeout: 1500,
      });
      const raw = response?.data?.state;
      if (typeof raw?.on !== "boolean" || raw.reachable === false)
        return { ok: false, error: "hue_state_unavailable" };
      const state = { on: raw.on, transitiontime: 0 };
      if (Number.isInteger(raw.bri)) state.bri = Math.max(0, Math.min(254, raw.bri));
      if (raw.colormode === "ct" && Number.isInteger(raw.ct)) state.ct = raw.ct;
      else if (
        raw.colormode === "xy" &&
        Array.isArray(raw.xy) &&
        raw.xy.length === 2 &&
        raw.xy.every(Number.isFinite)
      )
        state.xy = [...raw.xy];
      else if (Number.isInteger(raw.hue) && Number.isInteger(raw.sat)) {
        state.hue = raw.hue;
        state.sat = raw.sat;
      }
      if (["none", "colorloop"].includes(raw.effect)) state.effect = raw.effect;
      return { ok: true, state };
    } catch {
      return { ok: false, error: "hue_state_unavailable" };
    }
  };
