/**
 * Overlay profile storage.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const { createHash } = require("node:crypto");
function createOverlayProfileStorage(context) {
  let previous = null;
  const call = (method, payload) =>
    context.callCapability("ravelink.storage.v1", method, payload, {
      timeoutMs: 1000,
    });
  const key = (ref, index) => `ovp-${ref.generation}-${index}`;
  const valid = (ref) =>
    ref &&
    /^[a-f0-9]{64}$/.test(ref.generation) &&
    Number.isInteger(ref.count) &&
    ref.count >= 0 &&
    ref.count <= 16;
  async function restore(snapshot) {
    const ref = snapshot.overlayProfileStorage;
    if (!ref) return snapshot;
    if (!valid(ref)) throw new Error("overlay_profile_storage_invalid");
    const profiles = [];
    for (let i = 0; i < ref.count; i++) {
      const result = await call("get", { key: key(ref, i) });
      if (!result?.ok || !result.found || !result.value?.config)
        throw new Error("overlay_profile_storage_missing");
      profiles.push(result.value);
    }
    const generation = createHash("sha256").update(JSON.stringify(profiles)).digest("hex");
    if (generation !== ref.generation) throw new Error("overlay_profile_storage_invalid");
    previous = ref;
    return { ...snapshot, overlayProfiles: profiles };
  }
  async function prepare(snapshot) {
    const profiles = snapshot.overlayProfiles || [];
    const ref = {
      generation: createHash("sha256").update(JSON.stringify(profiles)).digest("hex"),
      count: profiles.length,
    };
    if (!valid(ref)) throw new Error("overlay_profile_storage_invalid");
    if (previous?.generation !== ref.generation) {
      for (let i = 0; i < profiles.length; i++) {
        const result = await call("set", {
          key: key(ref, i),
          value: profiles[i],
        });
        if (result?.ok === false) throw new Error("overlay_profile_storage_failed");
      }
    }
    const { overlayProfiles, ...state } = snapshot;
    return { ...state, overlayProfileStorage: ref };
  }
  async function committed(snapshot) {
    const next = snapshot.overlayProfileStorage,
      old = previous;
    previous = next;
    if (old && old.generation !== next.generation) {
      for (let i = 0; i < old.count; i++)
        try {
          await call("remove", { key: key(old, i) });
        } catch {}
    }
  }
  return { restore, prepare, committed };
}
module.exports = { createOverlayProfileStorage };
