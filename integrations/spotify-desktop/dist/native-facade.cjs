/**
 * Minimal facade over Spotify's captured native platform.
 * Keep platform shape probing and private-client assumptions in this adapter.
 * Do not export the captured platform object to the feature worker or browser HUD.
 * Capability absence must be explicit rather than guessed from account labels;
 * desktop-client updates can change the underlying methods independently of Core.
 */
// SPDX-License-Identifier: LGPL-2.1-only
// Reduced/adapted native Player/Queue access from Spicetify; see vendor/spicetify/NOTICE.md.
const { trackUri, artworkUrl } = require("./catalog.cjs");
module.exports = function createNativeFacade(platform, options = {}) {
  function service(name) {
    const value = platform?.["get" + name];
    if (typeof value === "function") return value.call(platform);
    if (platform?.[name]) return platform[name];
    return platform?.getRegistry?.()?.resolve(Symbol.for(name));
  }
  const player = () => {
    const value = service("PlayerAPI");
    if (!value) throw Error("spotify_player_unavailable");
    return value;
  };
  const queue = () => {
    const value = player()._queue;
    if (!value) throw Error("spotify_queue_unavailable");
    return value;
  };
  const state = () => {
    const value = player()._state;
    if (!value || typeof value.isPaused !== "boolean")
      throw Error("spotify_player_state_unavailable");
    return value;
  };
  const milliseconds = (input) =>
    Number.isFinite(Number(input)) ? Math.max(0, Math.min(86400000, Number(input))) : 0;
  function progress() {
    const value = state(),
      position = milliseconds(value.positionAsOfTimestamp),
      duration = milliseconds(value.duration);
    const timestamp = Number(value.timestamp),
      elapsed =
        !value.isPaused && !value.isBuffering && Number.isFinite(timestamp) && timestamp > 0
          ? milliseconds(Date.now() - timestamp)
          : 0;
    return Math.min(duration || Infinity, position + elapsed);
  }
  function tracks(rows, removal) {
    if (!Array.isArray(rows) || rows.length !== 1 || !trackUri(rows[0]?.uri))
      throw Error("spotify_track_invalid");
    const row = { uri: trackUri(rows[0].uri) };
    if (typeof rows[0].uid === "string" && rows[0].uid.length <= 200) row.uid = rows[0].uid;
    if (removal) {
      if (typeof rows[0].uid !== "string" || !rows[0].uid || rows[0].uid.length > 200)
        throw Error("spotify_queue_entry_id_required");
      row.uid = rows[0].uid;
    }
    return [row];
  }
  async function catalog(operation, variables) {
    const hash = options.catalog?.[operation];
    if (!["searchTracks", "getTrack"].includes(operation) || !/^[a-f0-9]{64}$/.test(hash || ""))
      throw Error("spotify_native_lookup_unavailable");
    const loader = service("GraphQLLoader");
    if (typeof loader !== "function") throw Error("spotify_native_lookup_unavailable");
    const reply = await loader(
      { name: operation, operation: "query", sha256Hash: hash, value: null },
      variables,
    );
    const rows =
      operation === "getTrack"
        ? [reply?.data?.trackUnion]
        : (reply?.data?.searchV2?.tracksV2?.items || []).map((row) => row.item?.data || row.data);
    return {
      tracks: {
        items: rows
          .slice(0, 10)
          .filter((row) => row?.__typename === "Track")
          .map((row) => ({
            uri: row.uri,
            name: row.name,
            duration_ms: row.duration?.totalMilliseconds,
            artists: (
              row.artists?.items || [
                ...(row.firstArtist?.items || []),
                ...(row.otherArtists?.items || []),
              ]
            ).map((artist) => ({ name: artist.profile?.name || artist.name })),
            album: { name: row.albumOfTrack?.name },
            is_playable: row.playability?.playable !== false,
          })),
      },
    };
  }
  const facade = {
    readPlaylist(input) {
      return require("./playlist-reader.cjs").read(service, input);
    },
    get Queue() {
      const value = queue(),
        snapshot =
          typeof value.getInternalQueue === "function"
            ? value.getInternalQueue()
            : (value._state ?? value._queue);
      // A signed-in, idle client can have no playback context yet. Its native
      // add-to-queue command can still accept tracks without starting playback.
      if (snapshot === null) return { nextTracks: [], track: null };
      if (!snapshot || !Array.isArray(snapshot.nextTracks))
        throw Error("spotify_queue_shape_unavailable");
      return snapshot;
    },
    async addToQueue(rows) {
      const value = queue(),
        entries = tracks(rows, false);
      if (typeof value._client?.addToQueue === "function") {
        // The high-level queue API discards this native acknowledgement. Keep
        // explicit rejections distinguishable from uncertain network delivery.
        const result = await value._client.addToQueue({
          track: entries[0],
          loggingParams: {
            commandInitiatedTime: { value: BigInt(Date.now()) },
          },
        });
        if (result?.error !== undefined && result.error !== 0)
          throw Error(
            result.error === 1 ? "spotify_playback_restricted" : "spotify_native_queue_rejected",
          );
        return result;
      }
      if (typeof value.addToQueue !== "function") throw Error("spotify_queue_append_unavailable");
      return value.addToQueue(entries);
    },
    removeFromQueue(rows) {
      const value = queue();
      if (typeof value.removeFromQueue !== "function")
        throw Error("spotify_queue_removal_unavailable");
      return value.removeFromQueue(tracks(rows, true));
    },
    Player: {
      getProgress: progress,
      isPlaying: () => !state().isPaused && !state().isBuffering,
      pause: () => player().pause(),
      play: () => player().resume(),
      next: () => player().skipToNext(),
      setVolume: (value) => {
        if (typeof player().setVolume !== "function") throw Error("spotify_volume_unavailable");
        return player().setVolume(value);
      },
    },
    localDevice() {
      try {
        const device = service("ConnectDevicesAPI")?.getActiveDevice?.();
        return device?.isLocal === true && device.isActive === true && device.isDisabled !== true;
      } catch {
        return false;
      }
    },
    searchCatalog(query) {
      if (
        typeof query !== "string" ||
        !query.trim() ||
        query.length > 300 ||
        /https?:\/\/|spotify:/i.test(query)
      )
        throw Error("spotify_search_query_invalid");
      return catalog("searchTracks", {
        searchTerm: query,
        offset: 0,
        limit: 10,
        includeAudiobooks: false,
        includePreReleases: false,
        includeAlbumPreReleases: false,
        includeAuthors: false,
        includeEpisodeContentRatingsV2: false,
      });
    },
    lookupCatalog(value) {
      const uri = trackUri(value);
      if (!uri) throw Error("spotify_track_invalid");
      return catalog("getTrack", { uri, includePrerelease: false });
    },
    snapshot() {
      const snapshot = facade.Queue,
        current = snapshot.track?.contextTrack || snapshot.track;
      let value;
      try {
        value = state();
      } catch {
        value = {};
      }
      const item = value.item || {},
        metadata = item.metadata || current?.metadata || {};
      const uri = trackUri(current?.uri || item.uri),
        uid = current?.uid || item.uid || value.playbackId || "";
      let deviceId = "";
      try {
        const device = service("ConnectDevicesAPI")?.getActiveDevice?.();
        const value = device?.id || device?.device_id || device?.deviceId;
        if (/^[A-Za-z0-9_-]{1,120}$/.test(value || "")) deviceId = value;
      } catch {}
      const manual = snapshot.nextTracks.filter((row) => row.provider === "queue");
      return {
        ok: true,
        complete: manual.length <= 40,
        localDevice: facade.localDevice(),
        ...(deviceId ? { deviceId } : {}),
        queue: manual
          .slice(0, 40)
          .map((row) => ({
            uri: trackUri(row.contextTrack?.uri || row.uri),
            uid: row.contextTrack?.uid || row.uid || "",
            origin: row.provider === "queue" ? "manual" : "playlist",
          }))
          .filter((row) => row.uri && row.uid),
        current: uri
          ? {
              uri,
              uid,
              title: String(metadata.title || metadata.name || ""),
              artists: [String(metadata.artist_name || "")].filter(Boolean),
              album: String(metadata.album_title || ""),
              artworkUrl:
                [
                  metadata.image_xlarge_url,
                  metadata.image_large_url,
                  metadata.image_url,
                  metadata.image_small_url,
                  item.album?.images?.[0]?.url,
                ]
                  .map(artworkUrl)
                  .find(Boolean) || "",
              durationMs: milliseconds(value.duration),
              positionMs: progress(),
              paused: value.isPaused === true,
              buffering: value.isBuffering === true,
            }
          : null,
      };
    },
    // Adapter compatibility name only: this is a narrow native read, not Spicetify's proxy.
    CosmosAsync: {
      async get(value) {
        const url = new URL(value);
        if (
          url.origin !== "https://api.spotify.com" ||
          url.username ||
          url.password ||
          url.hash ||
          !(
            url.pathname === "/v1/search" || /^\/v1\/tracks\/[A-Za-z0-9]{22}$/.test(url.pathname)
          ) ||
          (url.pathname === "/v1/search" &&
            (url.searchParams.get("type") !== "track" ||
              url.searchParams.get("limit") !== "10" ||
              !url.searchParams.get("q")?.trim() ||
              url.searchParams.get("q").length > 300 ||
              ["q", "type", "limit"].some((key) => url.searchParams.getAll(key).length !== 1) ||
              [...url.searchParams.keys()].some((key) => !["q", "type", "limit"].includes(key)))) ||
          (url.pathname !== "/v1/search" && url.search)
        )
          throw Error("spotify_lookup_route_invalid");
        const transport = player()._cosmos;
        if (typeof transport?.get === "function") return transport.get(url.href);
        const builder = service("RequestBuilder") || platform?.getRequestBuilder?.();
        if (typeof builder?.build !== "function") throw Error("spotify_native_lookup_unavailable");
        const response = await builder
          .build()
          .withHost("https://api.spotify.com")
          .withPath(url.pathname)
          .withQueryParameters(Object.fromEntries(url.searchParams))
          .withMethod("GET")
          .send();
        return response?.body ?? response;
      },
    },
  };
  return Object.freeze(facade);
};
