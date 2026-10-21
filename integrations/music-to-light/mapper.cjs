/** Deterministic measured-audio -> artistic intent. No I/O, scheduler, automatic
 * gain, BPM guessing or transport-specific state. Quiet/loud changes only the
 * dedicated brightness field; RGB retains the selected palette identity.
 */
const { settings, FEELS, fault } = require("./mapping-settings.cjs");
const scenarios = require("./scenarios.cjs");
const recipes = require("./recipe.cjs");
const crypto = require("node:crypto");
const ROLES = Object.freeze(["all", "low", "mid", "high"]);
const clamp = (n) => Math.max(0, Math.min(1, n));
const { rgb, hsv, fromHsv, blend } = require("./palette-math.cjs");
const { compose } = require("./composition.cjs");

module.exports = function createMusicMapper(input, { random = Math.random, history = null } = {}) {
  const attacks = require("./attack-response.cjs")();
  const musicalColor = require("./musical-color.cjs")();
  const temperature = require("./temperature-colors.cjs").create();
  const loudnessBody = require("./loudness-body.cjs")();
  let lastColorOnsetMs = -Infinity;
  let config = settings(input),
    latest = null,
    lastFrame = null,
    discontinuities = 0,
    onsetIds = { classic: 0, log: 0 },
    positions = [0, 1 / 3, 2 / 3, 1],
    steps = 0,
    lastOnsetMs = -Infinity,
    origin = null,
    quietSince = null,
    audioTravel = 0,
    sideFrom = 0,
    sideTarget = 0,
    sideChangedAt = 0,
    onsetFrom = null,
    waveOnsets = [],
    referenceWindow = [],
    referenceLimited = 0,
    selection = null;
  let levels = [0, 0, 0, 0],
    beds = [0, 0, 0, 0],
    rises = [0, 0, 0, 0];
  const isLocked = (config) =>
    (config.recipeOptions.palette?.mode === "fixed" &&
      config.recipeOptions.palette.value === "generated") ||
    config.scenarioMode === "random" ||
    Object.values(config.recipeOptions).some((o) => o.mode === "random") ||
    Object.keys(config.parameterRanges).length > 0;
  let recipeLocked = isLocked(config);
  let recipeId = recipeLocked ? crypto.randomBytes(6).toString("hex") : null;
  // Resolve the complete random recipe before any audio arrives. Signal level,
  // genre, silence, discontinuities and browser polling cannot change its type.
  if (config.scenarioMode === "random") {
    selection = scenarios.choose(
      config.scenarioWeights,
      random,
      config.behaviors.expressiveEnabled && config.behaviors.shuffleChoicesEnabled ? history : null,
    );
    if (!selection) throw fault("music_no_scenarios_enabled");
    if (config.layerMode === "random")
      selection.layers = scenarios.chooseLayers(config.behaviors, selection.id, random);
    if (selection.layers && config.raveColorPlan !== "configured")
      selection.layers.colorEnabled = config.behaviors.colorEnabled;
  }
  let assembled = recipes.resolve(
    config,
    selection?.id,
    random,
    config.behaviors.expressiveEnabled && config.behaviors.shuffleChoicesEnabled ? history : null,
  );
  // Legacy one-color palettes remain loadable. A complementary endpoint makes
  // reactive color movement useful without changing brightness or consuming RNG.
  function ensurePalette() {
    config.palette = [...new Set(config.palette)];
    if (config.palette.length === 1) {
      const [h, s, v] = hsv(rgb(config.palette[0]));
      const alternate = fromHsv([(h + 0.5) % 1, Math.max(0.65, s), Math.max(0.65, v)]);
      config.palette.push(`#${alternate.map((n) => n.toString(16).padStart(2, "0")).join("")}`);
    }
  }
  ensurePalette();
  if (selection?.layers && assembled.shape !== "unison")
    selection.layers.spatialEnabled = config.behaviors.spatialEnabled;
  if (selection?.layers) selection.layers.colorEnabled = config.behaviors.colorEnabled;
  const preset = () => selection?.preset || config.preset;
  const behavior = () =>
    selection?.layers && config.layerMode === "random"
      ? {
          ...config.behaviors,
          ...Object.fromEntries(
            Object.entries(selection.layers).map(([id, selected]) => [
              id,
              selected && config.behaviors[id],
            ]),
          ),
        }
      : config.behaviors;
  // Read-only interpolation: display polling must never advance a color or
  // spatial transition. An interruption starts at the exact interpolated value,
  // rather than jumping to a previous target that was never actually reached.
  function sideAt(at) {
    const t = clamp((at - sideChangedAt) / behavior().handoffMs);
    return sideFrom + (sideTarget - sideFrom) * t * t * (3 - 2 * t);
  }
  function onsetColor(at, slot) {
    const palette = config.palette.map(rgb),
      b = behavior();
    const target = palette[(steps + slot) % palette.length];
    const from = onsetFrom?.[slot] || palette[slot % palette.length];
    const t = b.colorBlendMs ? clamp((at - lastColorOnsetMs) / b.colorBlendMs) : 1;
    const elapsed = at - (Number.isFinite(lastColorOnsetMs) ? lastColorOnsetMs : origin);
    const drift = Math.max(0, elapsed - config.colorSeconds * 1000) / (config.colorSeconds * 1000);
    if (drift > 0) {
      const phase = (steps + slot + drift * FEELS[config.feel].motion) % palette.length;
      const i = Math.floor(phase);
      return blend(
        palette[i],
        palette[(i + 1) % palette.length],
        phase - i,
        b.colorVibrance,
        b.expressiveEnabled && b.perceptualColorsEnabled,
      );
    }
    return blend(
      from,
      target,
      t * t * (3 - 2 * t),
      b.colorVibrance,
      b.expressiveEnabled && b.perceptualColorsEnabled,
    );
  }
  function metrics(at) {
    return {
      level: levels[0],
      rise: Math.min(levels[0], rises[0]),
      spread: Math.max(...levels.slice(1)) - Math.min(...levels.slice(1)),
      attack: Number.isFinite(lastOnsetMs) && at - lastOnsetMs < 500,
      ...(behavior().expressiveEnabled
        ? {
            attackStrength: attacks.activity(at),
            energyRise: Math.max(0, levels[0] - beds[0]),
            colorMotion: behavior().colorEnabled && levels[0] > 0.01,
          }
        : {}),
      referenceSaturation: referenceWindow.length ? referenceLimited / referenceWindow.length : 0,
      referenceSamples: referenceWindow.length,
    };
  }
  function update(event, sampledAt) {
    if (
      !Number.isFinite(sampledAt) ||
      !Number.isSafeInteger(event?.endFrame) ||
      event.endFrame < 960 ||
      !Number.isSafeInteger(event.discontinuities) ||
      event.discontinuities < discontinuities ||
      !Number.isFinite(event.rms) ||
      event.rms < 0 ||
      event.rms > 8 ||
      event.invalidSamples !== 0 ||
      !["silent", "signal"].includes(event.signal)
    )
      throw fault("invalid_music_sample");
    if ((event.rms === 0) !== (event.signal === "silent")) throw fault("invalid_music_sample");
    if (event.discontinuities !== discontinuities) {
      levels = [0, 0, 0, 0];
      beds = [0, 0, 0, 0];
      rises = [0, 0, 0, 0];
      lastOnsetMs = lastColorOnsetMs = -Infinity;
      attacks.reset();
      musicalColor.reset();
      temperature.reset();
      loudnessBody.reset();
      waveOnsets = [];
      lastFrame = null;
      quietSince = null;
    }
    if (lastFrame !== null && event.endFrame <= lastFrame) throw fault("music_sample_order");
    const delta = lastFrame === null ? 20 : ((event.endFrame - lastFrame) * 1000) / 48000;
    if (delta > 250 || (latest && sampledAt < latest.sampledAt)) throw fault("music_sample_gap");
    const spectrum = event.analysis;
    if (
      spectrum &&
      (!spectrum.valid ||
        !Array.isArray(spectrum.bandRms) ||
        spectrum.bandRms.length !== 3 ||
        !spectrum.bandRms.every((n) => Number.isFinite(n) && n >= 0 && n <= 16))
    )
      throw fault("invalid_music_spectrum");
    const detector =
      config.behaviors.expressiveEnabled &&
      config.behaviors.logAttacksEnabled &&
      Object.hasOwn(spectrum || {}, "logOnset")
        ? "log"
        : "classic";
    const onset = detector === "log" ? spectrum.logOnset : spectrum?.onset;
    if (onset) {
      if (
        !Number.isSafeInteger(onset.id) ||
        onset.id <= onsetIds[detector] ||
        onset.detectedAtFrame !== event.endFrame
      )
        throw fault("music_onset_replayed");
      const b = behavior();
      attacks.accept(
        onset,
        detector === "log" ? spectrum.logOnsetThreshold : spectrum.onsetThreshold,
        b.expressiveEnabled,
        sampledAt,
        b.pulseDecayMs * FEELS[config.feel].envelope * (1 + 0.6 * b.smoothing),
      );
      onsetIds[detector] = onset.id;
      lastOnsetMs = sampledAt;
      // The native detector has already qualified this event. Do not discard
      // regular musical attacks with a second threshold on excess novelty.
      {
        onsetFrom = config.palette.map((_, slot) => onsetColor(sampledAt, slot));
        lastColorOnsetMs = sampledAt;
        steps++;
        if (b.expressiveEnabled && b.smoothShapesEnabled)
          waveOnsets = require("./composition.cjs").rememberOnset(
            waveOnsets,
            sampledAt,
            b,
            FEELS[config.feel],
          );
        else {
          waveOnsets.push(sampledAt);
          if (waveOnsets.length > 16) waveOnsets.shift();
        }
        const nextSide = Math.floor((steps - 1) / Math.max(1, Math.round(b.handoffHits))) % 2;
        if (nextSide !== sideTarget) {
          sideFrom = sideAt(sampledAt);
          sideTarget = nextSide;
          sideChangedAt = sampledAt;
        }
      }
      attacks.retain(waveOnsets);
    }
    const energies = [event.rms, ...(spectrum?.bandRms || [0, 0, 0])];
    const b = behavior();
    const envelope = FEELS[config.feel].envelope;
    // Envelopes use sample time, not chunk arrival or display polling cadence.
    const attack =
      (config.interpretation === "literal"
        ? b.literalAttackMs
        : preset() === "ambient"
          ? b.ambientAttackMs
          : b.attackMs) *
      envelope *
      (1 + 0.4 * b.smoothing);
    const release =
      (config.interpretation === "literal"
        ? b.literalReleaseMs
        : preset() === "ambient"
          ? b.ambientReleaseMs
          : b.releaseMs) *
      envelope *
      (1 + 0.8 * b.smoothing);
    const overallDb = event.rms === 0 ? -Infinity : 20 * Math.log10(event.rms);
    const overallTarget = clamp((overallDb - config.floorDb) / (config.ceilingDb - config.floorDb));
    // Diagnostics only: a bounded recent window counts how often the fixed
    // reference clips the measured input. It never changes gain or the recipe.
    const limited = overallDb >= config.ceilingDb;
    referenceWindow.push({ at: sampledAt, limited });
    if (limited) referenceLimited++;
    while (referenceWindow.length > 500 || sampledAt - referenceWindow[0].at > 10000)
      if (referenceWindow.shift().limited) referenceLimited--;
    // Integrate measured energy, not wall time: spatial swells cannot keep
    // chasing around a silent room. This phase never selects another recipe.
    if (lastFrame !== null) audioTravel += (delta / 1000) * overallTarget;
    levels = levels.map((value, i) => {
      const db = energies[i] === 0 ? -Infinity : 20 * Math.log10(energies[i]);
      // Musical band balance is a fixed artistic tilt, not instrument detection
      // or adaptive normalization. Wide-band RMS naturally favors bass in many
      // mixes. Modest mid/treble trims keep their measured movement visible.
      // Overall loudness caps the result so a quiet treble-only passage cannot
      // become bright just because its band receives a trim. Literal stays raw.
      const trim =
        config.interpretation === "musical" && b.balanceEnabled && i > 0
          ? [0, 0, b.midTrimDb, b.highTrimDb][i]
          : 0;
      const calibrated = clamp((db + trim - config.floorDb) / (config.ceilingDb - config.floorDb));
      let target =
        config.interpretation === "musical" && i > 0
          ? Math.min(overallTarget, calibrated)
          : calibrated;
      if (config.interpretation === "musical" && preset() === "bands" && i > 0) {
        // Each band's measured share remains visible below the full-mix floor.
        // This fixed curve has no learning window or changing gain. Zero energy
        // stays zero; absolute overall calibration still gates/caps every band.
        const share = event.rms > 0 ? clamp((energies[i] * 10 ** (trim / 20)) / event.rms) : 0;
        target = overallTarget * share ** b.bandSensitivity;
      }
      loudnessBody.update(
        i,
        target,
        delta,
        b,
        !!onset,
        !!onset &&
          attacks.latestImpact() > 0 &&
          attacks.latestImpact() >=
            attacks.impact(
              sampledAt,
              b.pulseDecayMs * FEELS[config.feel].envelope * (1 + 0.6 * b.smoothing),
            ),
      );
      return (
        value + (target - value) * (1 - Math.exp(-delta / (target > value ? attack : release)))
      );
    });
    // A slow reference separates a new rise from an already sustained note.
    // This is a difference, never a division/automatic gain: a quiet passage
    // cannot be normalized into a loud one. Each band owns its own reference,
    // so a bass attack cannot manufacture activity on the treble fixtures.
    beds = beds.map(
      (value, i) =>
        value + (levels[i] - value) * (1 - Math.exp(-delta / (b.referenceMs * envelope))),
    );
    rises = rises.map((value, i) => {
      const target = clamp(Math.max(0, levels[i] - beds[i]) * b.riseGain);
      return Math.max(target, value * Math.exp(-delta / (b.riseDecayMs * envelope)));
    });
    temperature.update(spectrum?.bandRms, delta);
    musicalColor.update({
      delta,
      energy: overallTarget,
      bands: spectrum?.bandRms,
      flux: detector === "log" ? spectrum?.logSpectralFlux : spectrum?.spectralFlux,
      threshold: detector === "log" ? spectrum?.logOnsetThreshold : spectrum?.onsetThreshold,
      strength: onset ? attacks.latest() : 0,
      seconds: config.colorSeconds,
      blendMs: b.colorBlendMs,
      motion: FEELS[config.feel].motion,
    });
    origin ??= sampledAt;
    quietSince = overallTarget === 0 ? (quietSince ?? sampledAt) : null;
    latest = {
      sampledAt,
      bandsReady: !!spectrum,
      loggedAnalysis: Object.hasOwn(spectrum || {}, "logOnset"),
      signal: event.signal,
    };
    lastFrame = event.endFrame;
    discontinuities = event.discontinuities;
  }
  function render(
    at,
    { role = "all", position = 0, onsetSince, outOfSync = 0, contrastSlot = 0.5 } = {},
  ) {
    if (
      !ROLES.includes(role) ||
      !Number.isFinite(position) ||
      position < 0 ||
      position > 1 ||
      !Number.isFinite(at) ||
      !Number.isInteger(outOfSync) ||
      outOfSync < 0 ||
      outOfSync > 100 ||
      !Number.isFinite(contrastSlot) ||
      contrastSlot < 0 ||
      contrastSlot > 1
    )
      throw fault("invalid_music_role");
    if (onsetSince !== undefined && (!Number.isFinite(onsetSince) || onsetSince > at))
      throw fault("invalid_music_role");
    if (!latest || at - latest.sampledAt > 250 || at < latest.sampledAt - 20) return null;
    const quiet = quietSince !== null && at - quietSince >= 1000;
    const b = behavior();
    const arrangement =
      selection?.id === "bands"
        ? "roles"
        : assembled.shape !== "unison"
          ? "spatial"
          : config.arrangement;
    const banded = preset() === "bands" || arrangement === "roles";
    if (banded && (role !== "all" || preset() === "bands") && !latest.bandsReady) return null;
    // Random band scenarios must work with an ordinary "all" fixture route.
    // Explicit roles win; otherwise positions distribute low/mid/high duties.
    const index = banded
      ? preset() === "bands" && role === "all"
        ? 1 + Math.min(2, Math.floor(position * 3))
        : ROLES.indexOf(role)
      : 0;
    const accentsEnabled =
      b.attacksEnabled &&
      (preset() === "pulse" || (config.interpretation === "musical" && b.loudnessBrightness));
    let pulse = accentsEnabled
      ? attacks.level(at, b.pulseDecayMs * FEELS[config.feel].envelope * (1 + 0.6 * b.smoothing))
      : 0;
    // A travelling wave carries its measured attack with the front. Decaying
    // every fixture from the original global onset made the far end lose its
    // accent before the wave arrived, especially with fast response feels.
    if (
      accentsEnabled &&
      b.expressiveEnabled &&
      b.smoothShapesEnabled &&
      b.spatialEnabled &&
      assembled.shape === "wave"
    ) {
      const duration = b.waveMs / FEELS[config.feel].motion;
      const decay = b.pulseDecayMs * FEELS[config.feel].envelope * (1 + 0.6 * b.smoothing);
      pulse = Math.max(
        0,
        ...waveOnsets
          .filter((t) => at >= t && at - t < duration)
          .map(
            (t) => attacks.weight(t) * Math.exp(-Math.max(0, at - t - duration * position) / decay),
          ),
      );
    }
    // Preserve one newly measured attack until the next bounded output slot.
    // Rendering/polling does not consume the event or restart its decay. The
    // scheduler supplies its previous output boundary, so fast feels cannot
    // disappear entirely between four-Hz transport slots.
    if (accentsEnabled && onsetSince !== undefined && lastOnsetMs > onsetSince && lastOnsetMs <= at)
      pulse = Math.max(pulse, attacks.latest());
    // Presets describe different audio relationships rather than variations of
    // one smoothed meter. Pulse leaves most of the range for measured attacks;
    // a held synth note keeps a small bed instead of staying at peak brightness.
    // Literal bypasses artistic accents. Nothing advances without fresh audio.
    const level = levels[index];
    const rise = b.swellsEnabled ? Math.min(level, rises[index]) : 0;
    let response = level;
    let spatialMask = 1;
    if (config.interpretation === "musical") {
      if (preset() === "pulse")
        response = level * (b.loudnessBrightness ? pulse : b.pulseBed + (1 - b.pulseBed) * pulse);
      else if (preset() === "bands") {
        // Fixed competition between simultaneously measured bands, not an
        // instrument classifier or recipe switch. Absent bands remain dark.
        const strongest = Math.max(...levels.slice(1));
        const relative = strongest > 0 ? clamp(level / strongest) : 0;
        const separation = 0.15 + 0.85 * relative ** (b.bandSeparation - 1);
        response = (b.bandsBed * level + (1 - b.bandsBed) * rise) * separation;
      } else {
        // Symmetric contrast preserves endpoints and midpoint without adapting
        // to a song's average level. Envelope timing still provides the glide.
        const lo = level ** b.ambientContrast;
        const hi = (1 - level) ** b.ambientContrast;
        response = b.ambientBed * (lo / (lo + hi)) + (1 - b.ambientBed) * rise;
      }
      if (b.expressiveEnabled && b.smoothShapesEnabled && b.spatialEnabled) {
        spatialMask *= compose({
          shape: assembled.shape,
          position,
          positions,
          at,
          onsets: waveOnsets,
          audioTravel,
          side: sideAt(at),
          feel: FEELS[config.feel],
          b,
        });
      } else if (!b.expressiveEnabled || !b.smoothShapesEnabled) {
        if (
          assembled.shape === "wave" &&
          b.spatialEnabled &&
          Number.isFinite(lastOnsetMs) &&
          at - lastOnsetMs < b.waveMs / FEELS[config.feel].motion
        ) {
          const duration = b.waveMs / FEELS[config.feel].motion;
          const voices = waveOnsets
            .slice(-Math.round(b.waveVoices))
            .filter((t) => at - t < duration);
          // Overlapping fronts keep older attacks travelling when a new one
          // arrives. Max-composition cannot exceed the measured brightness cap;
          // one voice reproduces the original single-front relationship.
          const weight = Math.max(
            ...voices.map((t) => {
              const age = clamp((at - t) / duration);
              const spatial = 1 - b.waveDepth * clamp(Math.abs(position - age) / b.waveWidth);
              return spatial * (b.waveVoices > 1 ? 1 - 0.35 * age : 1);
            }),
          );
          spatialMask *= weight;
        }
        if (b.spatialEnabled && ["bounce", "mirror"].includes(assembled.shape)) {
          const cycle = (audioTravel / b.bounceSeconds) % 1;
          const front = 1 - Math.abs(2 * cycle - 1);
          const location = assembled.shape === "mirror" ? Math.abs(position - 0.5) * 2 : position;
          spatialMask *= 1 - b.interactionDepth * clamp(Math.abs(location - front) / b.waveWidth);
        }
        if (b.spatialEnabled && assembled.shape === "handoff") {
          const front = sideAt(at);
          spatialMask *= 1 - b.interactionDepth * Math.abs(position - front);
        }
        if (b.spatialEnabled && assembled.shape === "swell") {
          const phase = audioTravel / b.swellTravelSeconds - position * b.swellSpan;
          spatialMask *=
            1 - b.swellDepth + b.swellDepth * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase));
        }
      }
      response *= spatialMask;
    }
    // Keep loudness outside the percussive envelope and spatial masks. Missing
    // onsets must not make a sustained loud passage fall to a pulse trough.
    if (config.interpretation === "musical" && b.loudnessBrightness)
      response = loudnessBody.mix(
        index,
        preset() === "pulse" ? response : level * pulse * spatialMask,
        b,
        accentsEnabled && b.expressiveEnabled
          ? attacks.impact(
              at,
              b.pulseDecayMs * FEELS[config.feel].envelope * (1 + 0.6 * b.smoothing),
              onsetSince,
            )
          : null,
        level,
      );
    let amount = quiet ? 0 : (b.steadyBrightness ? 1 : clamp(response)) * config.intensity;
    if (!quiet && !b.steadyBrightness && config.interpretation === "musical")
      amount = require("./fixture-contrast.cjs").amount(amount, {
        percent: outOfSync,
        slot: contrastSlot,
        level: levels[0],
        bands: levels.slice(1),
        attack: b.attacksEnabled ? attacks.activity(at) : 0,
      });
    const brightness =
      config.minimumBrightness + (config.maximumBrightness - config.minimumBrightness) * amount;
    const palette = config.palette.map(rgb);
    const audioColors =
      b.expressiveEnabled && b.perceptualColorsEnabled && config.interpretation === "musical";
    const roleColor = arrangement === "roles" ? Math.max(0, index - 1) : 0;
    const colorOffset = (outOfSync / 100) * contrastSlot * palette.length;
    let color = palette[roleColor % palette.length];
    if (!quiet && b.colorEnabled && ["roles", "fixed"].includes(config.colorMode)) {
      const slot =
        role === "all"
          ? Math.min(2, Math.floor(position * 3))
          : Math.max(0, ROLES.indexOf(role) - 1);
      // Role is a phase offset, not a permanent color assignment. The legacy
      // fixed enum now means together cycling; explicit layer blocks still win.
      const offset = config.colorMode === "roles" ? slot : roleColor;
      const phase =
        ((Math.max(0, at - origin) / (config.colorSeconds * 1000)) * FEELS[config.feel].motion +
          offset +
          colorOffset) %
        palette.length;
      const i = Math.floor(phase);
      color = audioColors
        ? musicalColor.color(palette, offset + colorOffset)
        : blend(
            palette[i],
            palette[(i + 1) % palette.length],
            phase - i,
            b.colorVibrance,
            b.expressiveEnabled && b.perceptualColorsEnabled,
          );
    }
    if (!quiet && b.colorEnabled && config.colorMode === "energy") {
      const phase =
          (clamp(levels[0]) * (palette.length - 1) +
            (Math.max(0, at - origin) / (config.colorSeconds * 1000)) * FEELS[config.feel].motion +
            colorOffset) %
          palette.length,
        i = Math.floor(phase);
      color = audioColors
        ? musicalColor.color(palette, clamp(levels[0]) * (palette.length - 1) + colorOffset)
        : blend(
            palette[i],
            palette[(i + 1) % palette.length],
            phase - i,
            b.colorVibrance,
            b.expressiveEnabled && b.perceptualColorsEnabled,
          );
    }
    if (!quiet && b.colorEnabled && config.colorMode === "onsets") {
      color =
        b.expressiveEnabled &&
        b.perceptualColorsEnabled &&
        config.interpretation === "musical" &&
        b.colorBlendMs > 0
          ? musicalColor.color(palette, roleColor + colorOffset)
          : outOfSync === 0
            ? onsetColor(at, roleColor)
            : blend(
                onsetColor(at, (roleColor + Math.floor(colorOffset)) % palette.length),
                onsetColor(at, (roleColor + Math.floor(colorOffset) + 1) % palette.length),
                colorOffset % 1,
                b.colorVibrance,
                b.expressiveEnabled && b.perceptualColorsEnabled,
              );
    }
    if (!quiet && b.colorEnabled && config.colorMode === "travel") {
      const offset = arrangement === "spatial" ? position * (palette.length - 1) : roleColor;
      const phase =
        ((preset() === "ambient"
          ? audioTravel / config.colorSeconds
          : Math.max(0, at - origin) / (config.colorSeconds * 1000)) *
          FEELS[config.feel].motion +
          offset +
          colorOffset) %
        palette.length;
      const i = Math.floor(phase);
      color = audioColors
        ? musicalColor.color(palette, offset + colorOffset)
        : blend(
            palette[i],
            palette[(i + 1) % palette.length],
            phase - i,
            b.colorVibrance,
            b.expressiveEnabled && b.perceptualColorsEnabled,
          );
    }
    if (!quiet && b.colorEnabled && config.warmCoolColors)
      color = temperature.map(
        palette,
        role,
        color,
        b.expressiveEnabled && b.perceptualColorsEnabled,
      );
    return {
      rgb: { r: color[0], g: color[1], b: color[2] },
      brightness,
      sampledAt: latest.sampledAt,
      quiet,
      role,
      measuredSignal: latest.signal,
    };
  }
  return Object.freeze({
    update,
    setPositions(values) {
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 64 ||
        values.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
      )
        throw fault("invalid_music_role");
      positions = [...new Set(values)];
    },
    render,
    preset,
    inspect(at) {
      const fresh = !!latest && at - latest.sampledAt <= 250 && at >= latest.sampledAt - 20;
      const m = metrics(at),
        b = behavior();
      const layers = [
        [
          "attacksEnabled",
          "layers",
          fresh &&
            b.attacksEnabled &&
            !b.steadyBrightness &&
            m.attack &&
            (preset() === "pulse" || b.loudnessBrightness) &&
            config.interpretation === "musical",
          b.expressiveEnabled && b.logAttacksEnabled
            ? !latest?.bandsReady
              ? "Waiting for spectral analysis"
              : latest?.loggedAnalysis
                ? "Log-spectral attacks · fixed gamma 100"
                : "Legacy attacks · rebuild the helper for log analysis"
            : "Measured onset shapes the attack envelope",
        ],
        [
          "swellsEnabled",
          "layers",
          fresh &&
            b.swellsEnabled &&
            !b.steadyBrightness &&
            m.rise > 0.01 &&
            preset() !== "pulse" &&
            config.interpretation === "musical",
          "Positive energy rises shape brightness",
        ],
        [
          "balanceEnabled",
          "analysis",
          fresh &&
            b.balanceEnabled &&
            config.interpretation === "musical" &&
            (preset() === "bands" || config.arrangement === "roles"),
          "Fixed band trims capped by overall loudness",
        ],
        [
          "colorEnabled",
          "color",
          fresh && b.colorEnabled && levels[0] > 0.01,
          "Palette cycling, with measured attacks or energy where selected",
        ],
        [
          "spatialEnabled",
          "shape",
          fresh &&
            b.spatialEnabled &&
            !b.steadyBrightness &&
            ((["bounce", "handoff", "mirror"].includes(assembled.shape) && m.level > 0.01) ||
              (assembled.shape === "wave" &&
                at - lastOnsetMs < b.waveMs / FEELS[config.feel].motion) ||
              (assembled.shape === "swell" && m.level > 0.01)),
          {
            wave: "Recent measured attacks travel across fixture positions",
            bounce: "Measured energy moves one focus between room ends",
            mirror: "Measured energy moves paired inner and outer fixtures",
            handoff: "Measured attacks crossfade the leading side",
            swell: "Measured energy moves a sustained swell across fixture positions",
          }[assembled.shape] || "Unified fixture response",
        ],
      ].map(([id, stage, active, reason]) => ({
        id,
        stage,
        enabled: config.behaviors[id],
        selected: b[id],
        active: !!active,
        reason:
          b.steadyBrightness && ["attacksEnabled", "swellsEnabled", "spatialEnabled"].includes(id)
            ? "Steady level overrides brightness motion; color response remains available"
            : reason,
      }));
      return {
        fresh,
        preset: preset(),
        scenario: selection ? structuredClone(selection) : null,
        mode: config.scenarioMode,
        recipeLocked,
        recipeId,
        recipe: structuredClone(assembled),
        metrics: fresh ? m : null,
        bands: fresh ? levels.slice(1) : [],
        effective: { ...structuredClone(config), behaviors: { ...b } },
        candidates: selection?.candidates || scenarios.chances(config.scenarioWeights),
        layers,
        stages: [
          "Audio source",
          "Verified analysis",
          "Scenario choice",
          "Shape + responsive layers",
          "Envelope + color blend",
          "Brightness limits + ownership",
        ],
      };
    },
    configure(input) {
      const priorFloor = config.floorDb,
        priorCeiling = config.ceilingDb;
      const next = settings(input);
      // Artistic edits are staged for the next activation. A running random
      // recipe accepts only tighter brightness ceilings; safety revocations are
      // handled by the owning session, which stops rather than swaps effects.
      if (recipeLocked) {
        const maximumBrightness = Math.min(config.maximumBrightness, next.maximumBrightness);
        config = settings({
          ...config,
          maximumBrightness,
          warmCoolColors: next.warmCoolColors,
          behaviors: {
            ...config.behaviors,
            steadyBrightness: next.behaviors.steadyBrightness,
            loudnessBrightness: next.behaviors.loudnessBrightness,
          },
          minimumBrightness: Math.min(config.minimumBrightness, maximumBrightness),
        });
      } else {
        config = settings({ ...next, scenarioMode: "manual" });
        assembled = recipes.resolve(
          config,
          null,
          random,
          config.behaviors.expressiveEnabled && config.behaviors.shuffleChoicesEnabled
            ? history
            : null,
        );
        ensurePalette();
        recipeLocked = isLocked(config);
        if (recipeLocked) recipeId = crypto.randomBytes(6).toString("hex");
        onsetFrom = null;
      }
      if (config.floorDb !== priorFloor || config.ceilingDb !== priorCeiling) {
        referenceWindow = [];
        referenceLimited = 0;
      }
      return structuredClone(config);
    },
    settings: () => structuredClone(config),
  });
};
