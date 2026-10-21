/** Operator libraries, paid viewer submissions and automatic song admission.
 * This owner never grants capture/output or chooses an unconfigured source. */
const createLibrary = require("../../../integrations/music-to-light/song-library.cjs");
const createAuto = require("../../../integrations/music-to-light/auto-rave.cjs");
const { song: timedSong } = require("../../../integrations/music-to-light/song-duration.cjs");
const fault = (code) => Object.assign(Error(code), { code });
module.exports = function createMusicLibraryRuntime({
  instance,
  savedEffects,
  readPlayback,
  storePath,
  captureProfile,
  brightnessLimit = () => 100,
}) {
  const library = createLibrary({ storePath });
  let lastPlayback = null,
    readTask = null,
    readAt = -Infinity;
  async function playback() {
    if (Date.now() - readAt < 1000) return lastPlayback;
    if (!readTask)
      readTask = Promise.resolve()
        .then(readPlayback)
        .then((value) => {
          lastPlayback = value;
          readAt = Date.now();
          return value;
        })
        .catch(() => null)
        .finally(() => {
          readTask = null;
        });
    return readTask;
  }
  const automation = createAuto({
    library,
    readPlayback: playback,
    active: () => !!instance.operator.raveInfo(),
    ready: () => {
      const status = instance.client.status(),
        bindings = instance.operator.bindings();
      if (!status.permissions.capture || !status.permissions.output) return "permissions_required";
      if (!instance.client.exportDesign().raveEnabled) return "rave_disabled";
      if (!bindings.fixtures.length) return "lights_required";
      if (!bindings.sources.some((source) => timedSong(lastPlayback, source, Date.now())))
        return "music_source_required";
      return null;
    },
    start: async (rule) => {
      if (rule.effectId && !savedEffects.snapshot().profiles.some((p) => p.id === rule.effectId))
        throw fault("music_effect_not_found");
      return instance.operator.rave({
        fixtureIds: instance.operator.bindings().fixtures.map((f) => f.id),
        origin: "auto",
        brightnessLimit: brightnessLimit(),
        songOnly: true,
        ...(rule.intensity === null ? {} : { intensity: rule.intensity }),
        ...(rule.effectId ? { effectPolicy: { mode: "single", ids: [rule.effectId] } } : {}),
      });
    },
    stop: () =>
      instance.operator.raveInfo()?.origin === "auto"
        ? instance.operator.stopRave()
        : Promise.resolve(),
  });
  if (library.snapshot().enabled) void automation.changed();
  async function snapshot() {
    const value = library.snapshot();
    return {
      ...value,
      current: createLibrary.currentSong(await playback()),
      automation: automation.snapshot(),
      rave: instance.operator.raveInfo(),
    };
  }
  function apply(kind, value) {
    return kind === "song" ? library.upsert(value) : savedEffects.add(value);
  }
  return {
    snapshot,
    async configure(value) {
      library.configure(value);
      if (Object.hasOwn(value, "enabled")) await automation.changed();
      return snapshot();
    },
    save(value) {
      if (value.effectId && !savedEffects.snapshot().profiles.some((p) => p.id === value.effectId))
        throw fault("music_effect_not_found");
      library.upsert(value);
      return snapshot();
    },
    remove(id) {
      library.remove(id);
      return snapshot();
    },
    review(value) {
      library.review(value, apply);
      return snapshot();
    },
    suppress: () => automation.suppress(createLibrary.currentSong(lastPlayback)),
    async viewer(command) {
      try {
        let value, kind;
        if (command.type === "rave-save") {
          kind = "effect";
          value = captureProfile({ name: command.value || "Viewer favourite" });
        } else {
          kind = "song";
          if (!command.value) {
            const song = createLibrary.currentSong(await playback());
            if (!song) throw fault("music_song_metadata_unavailable");
            value = {
              title: song.title,
              artist: song.artist,
              provider: song.provider,
              trackId: song.trackId,
            };
          } else if (/^https:\/\//i.test(command.value)) value = { url: command.value };
          else {
            const separator = command.value.indexOf(" - ");
            if (separator < 1) throw fault("music_song_use_artist_title_or_link");
            value = {
              artist: command.value.slice(0, separator),
              title: command.value.slice(separator + 3),
            };
          }
          value = createLibrary.songInput(value);
        }
        const result = library.submit(kind, value, (v) => apply(kind, v));
        return {
          matched: true,
          ok: true,
          effect: command.type,
          pending: result.pending,
          message: result.pending
            ? "Saved for streamer approval."
            : kind === "song"
              ? `Saved ${value.title} to the Rave song library.`
              : `Saved effect: ${value.name}.`,
          targets: [],
          sent: 0,
          failed: 0,
        };
      } catch (error) {
        return {
          matched: true,
          ok: false,
          effect: command.type,
          refundRecommended: true,
          error: /^[a-z_]{1,80}$/.test(error.code || "") ? error.code : "music_library_save_failed",
          targets: [],
          sent: 0,
          failed: 0,
        };
      }
    },
    shutdown: () => automation.shutdown(),
  };
};
