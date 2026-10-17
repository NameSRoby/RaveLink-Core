/**
 * Desktop adapter.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// Prototype client adapter; no network listener, client patching or automatic installation.
const { trackUri, searchPath, searchResult, candidate } = require("./catalog.cjs");
module.exports = function createSpotifyDesktopAdapter(api, options = {}) {
  const verifyLocalDevice = options.verifyLocalDevice;
  let serial = Promise.resolve();
  const ordered = (action) => {
    const result = serial.then(action);
    serial = result.catch(() => {});
    return result;
  };
  const capabilities = Object.freeze({
    mode: "desktop",
    queueAppend: typeof api?.addToQueue === "function",
    queueRemoval: typeof api?.removeFromQueue === "function",
    search: typeof api?.CosmosAsync?.get === "function",
    liveVerified: false,
  });
  function queue() {
    let rows;
    try {
      rows = api?.Queue?.nextTracks;
    } catch {
      return { ok: false, error: "spotify_queue_shape_unavailable" };
    }
    if (!Array.isArray(rows) || rows.length > 10000)
      return { ok: false, error: "spotify_queue_shape_unavailable" };
    const entries = [];
    for (const row of rows) {
      const track = row?.contextTrack || row;
      const uri = trackUri(track?.uri),
        uid = typeof track?.uid === "string" && track.uid.length <= 200 ? track.uid : "";
      if (uri)
        entries.push({
          uri,
          uid,
          origin:
            row.provider === "queue"
              ? "manual"
              : row.provider === "context"
                ? "playlist"
                : "unknown",
        });
    }
    return { ok: true, entries };
  }
  async function local() {
    try {
      return typeof verifyLocalDevice === "function" && (await verifyLocalDevice()) === true;
    } catch {
      return false;
    }
  }
  return {
    capabilities,
    queue,
    snapshot() {
      try {
        return api.snapshot();
      } catch {
        return {
          ok: false,
          localDevice: false,
          error: "spotify_queue_shape_unavailable",
        };
      }
    },
    control(input) {
      return ordered(async () => {
        if (!(await local())) return { ok: false, error: "spotify_local_device_unverified" };
        if (!["pause", "resume", "skip", "volume"].includes(input?.action))
          return { ok: false, error: "spotify_command_invalid" };
        if (
          input.action === "skip" &&
          (!input.currentUid || api.snapshot()?.current?.uid !== input.currentUid)
        )
          return { ok: false, error: "spotify_current_changed" };
        try {
          if (input.action === "volume") {
            if (!Number.isInteger(input.value) || input.value < 0 || input.value > 100)
              return { ok: false, error: "spotify_volume_invalid" };
            await api.Player.setVolume(input.value / 100);
            return { ok: true, accepted: true };
          }
          await api.Player[
            input.action === "resume" ? "play" : input.action === "skip" ? "next" : "pause"
          ]();
          return { ok: true, accepted: true };
        } catch {
          return { ok: false, error: "spotify_playback_restricted" };
        }
      });
    },
    async playlist(input) {
      if (!api.readPlaylist) return { ok: false, error: "spotify_playlist_unavailable" };
      return api.readPlaylist(input);
    },
    async lookup(value) {
      const uri = trackUri(value);
      if (!uri) return { ok: false, error: "spotify_track_invalid" };
      try {
        const found = candidate(
          await api.CosmosAsync.get("https://api.spotify.com/v1/tracks/" + uri.slice(14)),
        );
        return found
          ? { ok: true, candidates: [found] }
          : { ok: false, error: "spotify_search_shape_unavailable" };
      } catch {
        try {
          return searchResult(await api.lookupCatalog(uri));
        } catch {
          return { ok: false, error: "spotify_desktop_search_rejected" };
        }
      }
    },
    async search(query) {
      const route = searchPath(query);
      if (!route) return { ok: false, error: "spotify_search_query_invalid" };
      if (!capabilities.search) return { ok: false, error: "spotify_search_unavailable" };
      try {
        return searchResult(await api.CosmosAsync.get("https://api.spotify.com/v1" + route));
      } catch {
        try {
          return searchResult(await api.searchCatalog(query));
        } catch {
          return { ok: false, error: "spotify_desktop_search_rejected" };
        }
      }
    },
    append(value, appendOptions = {}) {
      return ordered(async () => {
        const uri = trackUri(value);
        if (!uri) return { ok: false, error: "spotify_track_invalid" };
        if (!capabilities.queueAppend)
          return { ok: false, error: "spotify_queue_append_unavailable" };
        if (!(await local())) return { ok: false, error: "spotify_local_device_unverified" };
        const before = queue();
        if (!before.ok) return before;
        const ids = new Set(before.entries.map((row) => row.uid).filter(Boolean));
        try {
          await api.addToQueue([
            {
              uri,
              ...(typeof appendOptions.uid === "string" && appendOptions.uid.length <= 200
                ? { uid: appendOptions.uid }
                : {}),
            },
          ]);
        } catch (error) {
          return {
            ok: false,
            error: ["spotify_playback_restricted", "spotify_native_queue_rejected"].includes(
              error.message,
            )
              ? error.message
              : "spotify_delivery_unconfirmed",
            retrySafe: false,
          };
        }
        let after = queue(),
          added = [];
        const deadline = Date.now() + (options.confirmationMs ?? 1500);
        do {
          added = after.ok
            ? after.entries.filter(
                (row) => row.uri === uri && row.uid && !ids.has(row.uid) && row.origin === "manual",
              )
            : [];
          if (added.length || Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          after = queue();
        } while (true);
        return added.length === 1
          ? { ok: true, delivery: "confirmed", uri, uid: added[0].uid }
          : {
              ok: false,
              error: "spotify_delivery_unconfirmed",
              retrySafe: false,
            };
      });
    },
    remove(entry) {
      return ordered(async () => {
        const uri = trackUri(entry?.uri),
          uid = typeof entry?.uid === "string" ? entry.uid : "";
        if (!uri || !uid || uid.length > 200)
          return { ok: false, error: "spotify_queue_entry_id_required" };
        if (!capabilities.queueRemoval)
          return { ok: false, error: "spotify_queue_removal_unavailable" };
        if (!(await local())) return { ok: false, error: "spotify_local_device_unverified" };
        const state = queue();
        if (!state.ok) return state;
        if (
          !state.entries.some(
            (row) => row.uri === uri && row.uid === uid && row.origin === "manual",
          )
        )
          return { ok: false, error: "spotify_queue_entry_not_found" };
        try {
          await api.removeFromQueue([{ uri, uid }]);
        } catch {
          return {
            ok: false,
            error: "spotify_removal_unconfirmed",
            retrySafe: false,
          };
        }
        const after = queue();
        return after.ok && !after.entries.some((row) => row.uid === uid)
          ? { ok: true, removed: true }
          : {
              ok: false,
              error: "spotify_removal_unconfirmed",
              retrySafe: false,
            };
      });
    },
  };
};
