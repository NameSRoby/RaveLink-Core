const test = require("node:test"),
  assert = require("node:assert/strict");
const inspect = require("../integrations/spotify-desktop/readiness-probe");

test("Spotify readiness probe reports only capabilities and queue shape without invoking Spotify actions", () => {
  const unexpected = () => {
    throw new Error("Probe must not call any client method");
  };
  const api = {
    accessToken: "private-token",
    user: { email: "private-account" },
    addToQueue: unexpected,
    removeFromQueue: unexpected,
    CosmosAsync: { get: unexpected },
    Player: {
      getProgress: unexpected,
      isPlaying: unexpected,
      pause: unexpected,
      play: unexpected,
      next: unexpected,
    },
    Queue: {
      track: { uri: "private-song", uid: "private-entry" },
      nextTracks: [
        {
          contextTrack: { uri: "private-song", uid: "private-entry" },
          provider: "queue",
        },
      ],
    },
  };
  const result = inspect(api);
  assert.ok(Object.values(result.capabilities).every(Boolean));
  assert.equal(result.upcomingCount, 1);
  assert.equal(result.upcomingShapes[0].uid, true);
  assert.equal(result.localDeviceVerified, false);
  assert.equal(result.liveBehaviorVerified, false);
  const output = JSON.stringify(result);
  for (const secret of ["private-token", "private-account", "private-song", "private-entry"])
    assert.equal(output.includes(secret), false);
});

test("missing or changed Spotify runtime remains unverified and does not crash the probe", () => {
  const absent = inspect();
  assert.equal(absent.spicetifyAvailable, false);
  assert.ok(Object.values(absent.capabilities).every((value) => value === false));
  const changed = inspect({ Queue: { nextTracks: {} } });
  assert.equal(changed.capabilities.readQueue, false);
  assert.equal(changed.liveBehaviorVerified, false);
  const unavailable = inspect({
    get Queue() {
      throw new Error("Unavailable");
    },
  });
  assert.equal(unavailable.error, "spotify_runtime_shape_unavailable");
});
