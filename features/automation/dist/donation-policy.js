const { createHash } = require('node:crypto');

const ACTIONS = ['overlay', 'overlayMessage', 'tts', 'spokenThanks', 'spokenMessage', 'chat', 'chatMessage', 'sound', 'lighting', 'goal'];
const WORDS = ['waffle wizard', 'sparkle turnip', 'noodle parade', 'wobbly pancake'];
const clean = (value, max) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, max).join('').trim() : '';
function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    actions: Object.fromEntries(ACTIONS.map(key => [key, source.actions?.[key] === true])),
    moderation: {
      level: Number.isInteger(source.moderation?.level) ? Math.max(0, Math.min(4, source.moderation.level)) : 2,
      approval: source.moderation?.approval === 'manual' ? 'manual' : 'automatic',
      treatment: ['hide', 'mask', 'funny'].includes(source.moderation?.treatment) ? source.moderation.treatment : 'hide',
      links: source.moderation?.links !== false,
      spam: source.moderation?.spam !== false,
      blocked: [...new Set((Array.isArray(source.moderation?.blocked) ? source.moderation.blocked : []).slice(0, 100).map(x => clean(x, 64)).filter(Boolean))]
    }
  };
}
function folded(value, level) {
  let text = level >= 2 ? value.normalize('NFKC').toLowerCase() : value.toLowerCase();
  if (level >= 3) text = text.replace(/[013457]/g, ch => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' })[ch]).replace(/(.)\1{2,}/gu, '$1');
  return text;
}
function privacyRisk(value) {
  // Conservative hints, not a claim to identify every name or address.
  return /@/.test(value) || /(?:\+?\d[\d ().-]{5,}\d)/u.test(value) || /\b(?:street|avenue|postcode|passport|ssn)\b/i.test(value);
}
function moderate(text, settings) {
  const policy = settings.moderation;
  if (privacyRisk(text)) return { status: 'held', text: '', reasons: ['possible_personal_information'] };
  if (policy.approval === 'manual') return { status: 'held', text: '', reasons: ['approval_required'] };
  if (!policy.level || !text) return { status: 'ready', text, reasons: [] };
  const spans = [], reasons = new Set();
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  for (const term of policy.blocked) {
    const words = [...term.matchAll(/[\p{L}\p{N}]+/gu)].map(match => folded(match[0], policy.level));
    if (!words.length) continue;
    for (let i = 0; i <= tokens.length - words.length; i++) {
      if (!words.every((word, j) => folded(tokens[i + j][0], policy.level) === word)) continue;
      const first = tokens[i], last = tokens[i + words.length - 1];
      spans.push([first.index, last.index + last[0].length]); reasons.add('blocked_phrase');
    }
  }
  if (policy.links) for (const match of text.matchAll(/(?:https?:\/\/|www\.)\S+/giu)) {
    spans.push([match.index, match.index + match[0].length]); reasons.add('link');
  }
  const counts = new Map();
  for (const token of tokens) { const key = folded(token[0], policy.level); counts.set(key, (counts.get(key) || 0) + 1); }
  const spam = policy.spam && (/(.)\1{9,}/u.test(text) || [...counts.values()].some(count => count >= (policy.level === 4 ? 5 : 10)));
  if (spam) { spans.push([0, text.length]); reasons.add('spam'); }
  if (!spans.length) return { status: 'ready', text, reasons: [] };
  if (policy.level === 4) return { status: 'held', text: '', reasons: [...reasons, 'strict_review'] };
  if (policy.treatment === 'hide') return { status: 'hidden', text: '', reasons: [...reasons] };
  const merged = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push([...span]);
  }
  let output = '', offset = 0;
  for (const [start, end] of merged) {
    const seed = createHash('sha256').update(text + ':' + start).digest()[0];
    const replacement = policy.treatment === 'funny' ? WORDS[seed % WORDS.length] : '[filtered]';
    output += text.slice(offset, start) + replacement; offset = end;
  }
  output += text.slice(offset);
  return { status: 'filtered', text: clean(output, 500), reasons: [...reasons] };
}
function previewDonation(raw, inputSettings) {
  const settings = normalizeSettings(inputSettings), actions = settings.actions;
  const isPublic = raw?.isPublic === true;
  const suppliedName = clean(raw?.publicDisplayName, 80);
  const nameCheck = moderate(suppliedName, { ...settings, moderation: { ...settings.moderation, approval: 'automatic' } });
  const name = isPublic && suppliedName && nameCheck.status === 'ready' ? suppliedName : 'Anonymous supporter';
  const result = isPublic ? moderate(clean(raw?.message, 500), settings) : { status: 'private', text: '', reasons: ['private_message'] };
  const message = result.text;
  const thanks = `Thank you, ${name}!`;
  return { ok: true, simulation: true, publicDisplayName: name, status: result.status, reasons: result.reasons,
    outputs: {
      overlay: actions.overlay ? { name, message: actions.overlayMessage ? message : '' } : null,
      speech: actions.tts ? [actions.spokenThanks ? thanks : '', actions.spokenMessage ? message.replaceAll('[filtered]', 'filtered') : ''].filter(Boolean).join(' ') : '',
      chat: actions.chat ? [thanks, actions.chatMessage ? message : ''].filter(Boolean).join(' ').slice(0, 500) : '',
      sound: actions.sound, lighting: actions.lighting, goal: actions.goal
    }
  };
}
module.exports = { ACTIONS, normalizeSettings, previewDonation };
