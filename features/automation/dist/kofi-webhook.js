const { timingSafeEqual } = require('node:crypto');

// Transport-neutral ingress validator. No HTTP listener or public route is registered.
function parseKoFiWebhook(body, expectedToken, options = {}) {
  if (!Buffer.isBuffer(body) || body.length > 65536) return { ok: false, code: 'invalid_body' };
  if (typeof expectedToken !== 'string' || !expectedToken || expectedToken.length > 256) return { ok: false, code: 'not_configured' };
  let raw;
  try {
    const fields = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (fields.getAll('data').length !== 1) return { ok: false, code: 'invalid_envelope' };
    raw = JSON.parse(fields.get('data'), (key, value) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid_key');
      return value;
    });
  } catch { return { ok: false, code: 'invalid_envelope' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_envelope' };
  const token = typeof raw.verification_token === 'string' ? raw.verification_token : '';
  const actual = Buffer.from(token), expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, code: 'verification_failed' };
  if (typeof raw.message_id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.message_id)) return { ok: false, code: 'invalid_event' };
  // Admit the verified tip shape first; other payment variants need account samples.
  if (raw.type !== 'Donation') return { ok: false, code: 'unsupported_payment_type' };
  if (raw.is_subscription_payment !== false || raw.is_first_subscription_payment !== false) return { ok: false, code: 'unsupported_subscription_variant' };
  if (typeof raw.amount !== 'string' || !/^\d{1,9}(?:\.\d{1,3})?$/.test(raw.amount) || typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) return { ok: false, code: 'invalid_money' };
  const precision = { USD: 2, EUR: 2, GBP: 2, AUD: 2, BRL: 2, CAD: 2, JPY: 0, SGD: 2, THB: 2, NZD: 2 }[raw.currency];
  if (precision === undefined || (raw.amount.split('.')[1] || '').length > precision || !/[1-9]/.test(raw.amount)) return { ok: false, code: 'invalid_money' };
  const text = (value, maximum) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, maximum).join('').trim() : '';
  const isPublic = raw.is_public === true;
  return { ok: true, event: { id: raw.message_id, provider: 'kofi', type: 'donation', amount: raw.amount, currency: raw.currency,
    isPublic, publicDisplayName: isPublic && options.publicNameFieldVerified === true ? text(raw.from_name, 80) || 'Anonymous supporter' : 'Anonymous supporter',
    message: isPublic ? text(raw.message, 500) : '' } };
}
module.exports = { parseKoFiWebhook };
