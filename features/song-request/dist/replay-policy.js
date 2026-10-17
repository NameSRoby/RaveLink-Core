/**
 * Replay policy.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const identity = (candidate) =>
  candidate ? `${candidate.provider}:${candidate.providerItemId}` : "";
module.exports = () => {
  let lastFinished = "";
  return {
    duplicate: (key, queue, managed) =>
      key === lastFinished ||
      key === identity(managed?.candidate) ||
      queue.some((row) => row.identity === key),
    acknowledge(state, candidate) {
      if (state === "started" || state === "progress") lastFinished = "";
      if (state === "ended") lastFinished = identity(candidate);
    },
    finished(key) {
      lastFinished = key;
    },
    snapshot: () => ({ replayIdentity: lastFinished }),
    restore(snapshot) {
      const value = Object.hasOwn(snapshot, "replayIdentity")
        ? snapshot.replayIdentity
        : ["playing", "paused"].includes(snapshot.managedPlayback?.status)
          ? ""
          : snapshot.recent?.findLast((row) => row.outcome === "played")?.identity || "";
      lastFinished =
        typeof value === "string" &&
        /^[a-z][a-z0-9-]{1,39}:[^\u0000-\u001f\u007f]{1,160}$/.test(value)
          ? value
          : "";
    },
  };
};
