const { hsvToRgb255, rgbToHex, createHueStateFromRgb, createHueStateWhite, createWizStateFromRgb, createWizStateWhite } = require('../colors/color-space');
const { extractDescriptors, applyDescriptors } = require('../colors/color-descriptors');
const RANDOM_COLOR_TOKENS = new Set(['random', 'rand', 'rnd']);
const TWITCH_COLOR_BRIGHTNESS = Object.freeze({ hueBriBright: 254, hueBriDim: 178, wizDimmingBright: 100, wizDimmingDim: 70 });

module.exports = function createTwitchColorDirectiveService(options = {}) {
  const colorLibrary = options.colorLibrary;
  if (!colorLibrary?.parseColorText) throw new Error('createTwitchColorDirectiveService requires colorLibrary.parseColorText()');
  function parseTwitchColorDirective(rawText, overrides = {}) {
    const settings = { allowFuzzy: true, allowDescriptors: true, defaultBrightness: 100, ...options.getParserOptions?.(), ...overrides };
    const source = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!source || source.length > 96) return { ok: false, error: source ? 'color_text_too_long' : 'missing color text' };
    let brightness = '', percent = null;
    const words = [];
    for (const word of source.split(' ')) {
      const key = word.toLowerCase();
      if (key === 'bright' || key === 'dim' || key.endsWith('%')) {
        const value = key === 'bright' ? 100 : key === 'dim' ? 70 : /^\d{1,3}%$/.test(key) ? Number(key.slice(0, -1)) : NaN;
        if (!Number.isInteger(value) || value < 1 || value > 100) return { ok: false, error: 'brightness_must_be_1_to_100_percent' };
        if (percent !== null && percent !== value) return { ok: false, error: 'conflicting_brightness' };
        percent = value; brightness = key;
      } else words.push(word);
    }
    const descriptors = extractDescriptors(words);
    if (!descriptors.ok) return descriptors;
    const modifiers = descriptors.modifiers;
    if (settings.allowDescriptors === false && Object.keys(modifiers).length) return { ok: false, error: 'color_descriptors_disabled' };
    const colorText = descriptors.words.join(' ');
    if (!colorText && Object.keys(modifiers).length) return { ok: false, error: 'descriptor_requires_color' };
    if (!colorText && percent === null) return { ok: false, error: 'missing color text' };
    const defaultPercent = Number(settings.defaultBrightness);
    const effective = percent ?? (Number.isInteger(defaultPercent) && defaultPercent >= 1 && defaultPercent <= 100 ? defaultPercent : 100);
    // Every call starts from its own settings and base color, never the preceding command.
    const outputPercent = Math.max(1, Math.round(effective * (modifiers.tone === 'dark' ? 0.55 : 1)));
    const hueBrightness = Math.round(outputPercent * 254 / 100);
    if (!colorText) return { ok: true, type: 'brightness_only', brightness, brightnessPercent: outputPercent, modifiers: {},
      hueState: { on: true, bri: hueBrightness, transitiontime: 2 }, wizState: { on: true, dimming: outputPercent } };
    const random = RANDOM_COLOR_TOKENS.has(colorText.toLowerCase());
    const parsed = random ? { ok: true, rgb: hsvToRgb255(Math.floor(Math.random() * 360), 1, 1), source: 'random' }
      : colorLibrary.parseColorText(colorText, { allowFuzzy: settings.allowFuzzy !== false });
    if (!parsed.ok) return { ok: false, error: parsed.error || 'invalid color text' };
    const rgb = applyDescriptors(parsed.rgb, modifiers);
    const white = parsed.matchedName === 'white' && Object.keys(modifiers).length === 0 && !/^#[0-9a-f]{6}$/i.test(colorText);
    return { ok: true, type: random ? 'random' : 'color', brightness, brightnessPercent: outputPercent, colorText,
      matchedName: parsed.matchedName || '', source: parsed.source || '', fuzzy: parsed.fuzzy || null,
      modifiers, hex: rgbToHex(rgb), baseHex: rgbToHex(parsed.rgb),
      hueState: white ? createHueStateWhite({ brightness: hueBrightness, transitiontime: 2 }) : createHueStateFromRgb(rgb, { brightness: hueBrightness, transitiontime: 2 }),
      wizState: white ? createWizStateWhite({ dimming: outputPercent }) : createWizStateFromRgb(rgb, { dimming: outputPercent }) };
  }
  return Object.freeze({ TWITCH_COLOR_BRIGHTNESS, parseTwitchColorDirective });
};
