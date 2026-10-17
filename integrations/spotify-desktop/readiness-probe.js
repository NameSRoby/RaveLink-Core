/**
 * Readiness probe.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// Read-only developer probe for the minimal RaveLink runtime or an existing Spicetify client.
// It does not install anything, contact a server, read tokens or modify playback.
function inspectSpotifyDesktop(api) {
  const method = (owner, name) => typeof owner?.[name] === "function";
  const shape = (row) => {
    const track = row?.contextTrack || row;
    return {
      uri: typeof track?.uri === "string",
      uid: typeof track?.uid === "string" && track.uid.length > 0,
      provider: typeof row?.provider === "string",
    };
  };
  try {
    const queue = api?.Queue,
      rows = queue?.nextTracks;
    return {
      schemaVersion: 1,
      spicetifyAvailable: Boolean(api),
      capabilities: {
        appendQueue: method(api, "addToQueue"),
        removeQueueEntry: method(api, "removeFromQueue"),
        readQueue: Array.isArray(rows),
        searchTransport: method(api?.CosmosAsync, "get"),
        progress: method(api?.Player, "getProgress"),
        playbackState: method(api?.Player, "isPlaying"),
        pause: method(api?.Player, "pause"),
        resume: method(api?.Player, "play"),
        skip: method(api?.Player, "next"),
      },
      upcomingCount: Array.isArray(rows) ? Math.min(rows.length, 10000) : null,
      upcomingShapes: Array.isArray(rows) ? rows.slice(0, 3).map(shape) : [],
      currentShape: shape(queue?.track),
      // Capability presence does not establish active device, search access or FIFO semantics.
      liveBehaviorVerified: false,
      localDeviceVerified: false,
    };
  } catch {
    return {
      schemaVersion: 1,
      spicetifyAvailable: Boolean(api),
      error: "spotify_runtime_shape_unavailable",
      liveBehaviorVerified: false,
      localDeviceVerified: false,
    };
  }
}
if (typeof module !== "undefined" && module.exports) module.exports = inspectSpotifyDesktop;
else
  console.log(
    JSON.stringify(
      window.__ravelinkSpotify?.status
        ? window.__ravelinkSpotify.status()
        : inspectSpotifyDesktop(window.Spicetify),
      null,
      2,
    ),
  );
