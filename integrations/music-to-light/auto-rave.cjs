/** One bounded owner for song triggers. No foreground/game inference and no
 * capture on import. Manual Stop suppresses the current playback instance. */
const { currentSong, matches } = require("./song-library.cjs");
module.exports = function createAutoRave({
  library,
  readPlayback,
  start,
  stop,
  active,
  ready,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer,
    closed = false,
    polling = false,
    generation = 0,
    observed = null,
    handled = false,
    previous = null,
    automatic = false,
    activeRule = null,
    suppressNext = false;
  let state = { reason: "off", song: null };
  function schedule() {
    clearTimer(timer);
    if (!closed && library.snapshot().enabled) {
      timer = setTimer(() => void tick(), 1000);
      timer?.unref?.();
    }
  }
  async function tick() {
    if (closed || polling || !library.snapshot().enabled) return;
    polling = true;
    const revision = generation;
    try {
      const song = currentSong(await readPlayback(), now());
      if (closed || revision !== generation || !library.snapshot().enabled) return;
      state.song = song;
      if (automatic && !library.snapshot().songs.some((r) => r.id === activeRule && r.enabled)) {
        await stop();
        automatic = false;
        handled = true;
        state.reason = "song_disabled";
      }
      if (!song) {
        state.reason = "waiting_metadata";
        return;
      }
      const replay =
        song.key === observed &&
        previous?.positionMs >= previous?.durationMs - 2500 &&
        song.positionMs !== null &&
        song.positionMs < 3000;
      if (song.key !== observed || replay) {
        observed = song.key;
        handled = suppressNext;
        suppressNext = false;
        if (automatic) {
          await stop();
          automatic = false;
        }
      }
      previous = song;
      if (song.status !== "playing") {
        state.reason = song.status;
        return;
      }
      if (handled) {
        if (automatic) state.reason = active() ? "playing_saved_song" : "waiting_next_song";
        return;
      }
      const rule = library.snapshot().songs.find((r) => r.enabled && matches(r, song));
      if (!rule) {
        state.reason = "not_saved";
        return;
      }
      if (active()) {
        handled = true;
        state.reason = "manual_priority";
        return;
      }
      const unavailable = ready(song);
      if (unavailable) {
        state.reason = unavailable;
        return;
      }
      handled = true;
      await start(rule, song);
      if (closed || revision !== generation) {
        await stop();
        return;
      }
      automatic = true;
      activeRule = rule.id;
      state.reason = "playing_saved_song";
    } catch (error) {
      state.reason = /^[a-z_]{1,80}$/.test(error.code || "") ? error.code : "music_auto_failed";
    } finally {
      polling = false;
      schedule();
    }
  }
  return {
    tick,
    snapshot: () => ({ ...structuredClone(state), automatic: automatic && active() }),
    suppress(song) {
      if (song) {
        observed = song.key;
        previous = song;
      }
      suppressNext = !observed;
      handled = true;
      automatic = false;
      state.reason = "stopped_for_this_playback";
      generation++;
    },
    async changed() {
      generation++;
      clearTimer(timer);
      if (!library.snapshot().enabled) {
        state.reason = "off";
        if (automatic) await stop();
        automatic = false;
      } else {
        handled = false;
        suppressNext = false;
        state.reason = "armed";
        schedule();
      }
    },
    async shutdown() {
      closed = true;
      generation++;
      clearTimer(timer);
      if (automatic) await stop();
    },
  };
};
