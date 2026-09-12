const DEFINITIONS = Object.freeze({
  light: ['tone', 'light'], lighter: ['tone', 'light'], pale: ['tone', 'pale'], pastel: ['tone', 'pale'], soft: ['tone', 'light'],
  dark: ['tone', 'dark'], darker: ['tone', 'dark'], deep: ['tone', 'dark'],
  muted: ['saturation', 'muted'], dusty: ['saturation', 'muted'], desaturated: ['saturation', 'muted'],
  vivid: ['saturation', 'vivid'], saturated: ['saturation', 'vivid'], intense: ['saturation', 'vivid'],
  warm: ['temperature', 'warm'], cool: ['temperature', 'cool']
});
function extractDescriptors(words) {
  const modifiers = {}, remaining = [];
  for (const word of words) {
    const definition = Object.hasOwn(DEFINITIONS, word.toLowerCase()) ? DEFINITIONS[word.toLowerCase()] : null;
    if (!definition) { remaining.push(word); continue; }
    const [family, value] = definition;
    if (modifiers[family] && modifiers[family] !== value) return { ok: false, error: `conflicting_${family}_descriptors` };
    modifiers[family] = value;
  }
  return { ok: true, modifiers, words: remaining };
}
function applyDescriptors(rgb, modifiers) {
  let values = [rgb.r, rgb.g, rgb.b];
  const mix = (other, amount) => { values = values.map((value, i) => value * (1 - amount) + other[i] * amount); };
  if (modifiers.saturation === 'muted') { const gray = values.reduce((a, b) => a + b, 0) / 3; mix([gray, gray, gray], 0.4); }
  if (modifiers.saturation === 'vivid') { const min = Math.min(...values), max = Math.max(...values); if (max > min) values = values.map(value => (value - min) * max / (max - min)); }
  if (modifiers.temperature) mix(modifiers.temperature === 'warm' ? [255, 180, 90] : [180, 210, 255], 0.18);
  if (modifiers.tone === 'light' || modifiers.tone === 'pale') mix([255, 255, 255], modifiers.tone === 'pale' ? 0.6 : 0.35);
  if (modifiers.tone === 'dark') mix([0, 0, 0], 0.45);
  const [r, g, b] = values.map(value => Math.round(Math.max(0, Math.min(255, value))));
  return { r, g, b };
}
module.exports = { DEFINITIONS, extractDescriptors, applyDescriptors };
