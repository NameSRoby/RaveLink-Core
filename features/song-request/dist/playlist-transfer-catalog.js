const { compact, rank } = require('./playlist-transfer-matching');
module.exports = context => async (source, target = 'tidal', adaptive = true) => {
  if (!['tidal', 'youtube', 'soundcloud'].includes(target)) throw new Error('transfer_provider_invalid');
  if (source.provider === target) {
    const reply = target === 'tidal' ? await context.callCapability('tidal.playlists.host.v1', 'action', { action: 'track', id: source.providerItemId }, { timeoutMs: 15000 }) : { ok: true, candidate: source };
    if (!reply.ok) return reply;
    return { ok: true, choices: [{ ...compact(reply.candidate), score: 100, reason: 'Same catalog identity' }], same: true };
  }
  const query = [...source.artists, source.title, source.version].filter(Boolean).join(' ').slice(0, 256);
  const reply = target === 'tidal'
    ? await context.callCapability('tidal.playlists.host.v1', 'action', { action: 'search', query, isrc: source.isrc || '' }, { timeoutMs: 15000 })
    : await context.callCapability(target + '.catalog.host.v1', 'resolve', { query, transfer: target === 'soundcloud' && adaptive, policy: { minimumConfidence: 0.5, minimumViews: 0, minimumSubscribers: 0, maxDurationMs: 86400000 }, maxDurationMs: 86400000 }, { timeoutMs: 12000 });
  if (!reply.ok && /rate_limited|busy/.test(reply.error || reply.reason || '')) return { ...reply, error: reply.error || reply.reason };
  let candidates = reply.candidates || [reply.candidate].filter(Boolean);
  if (target === 'soundcloud' && adaptive && source.title !== query && (!reply.ok || !candidates.length || rank(source, candidates)[0]?.score < 85)) {
    const fallback = await context.callCapability('soundcloud.catalog.host.v1', 'resolve', { query: source.title.slice(0,256), matchQuery: query, transfer: true, policy: { minimumConfidence: 0.5, maxDurationMs: 86400000 }, maxDurationMs: 86400000 }, { timeoutMs: 12000 });
    if (!fallback.ok && /rate_limited|busy/.test(fallback.error || fallback.reason || '')) return { ...fallback, error: fallback.error || fallback.reason };
    candidates.push(...(fallback.candidates || [fallback.candidate].filter(Boolean)));
  }
  if (!reply.ok && !candidates.length) return { ...reply, error: reply.error || reply.reason || 'catalog_unavailable' };
  candidates = [...new Map(candidates.map(candidate => [candidate.providerItemId, candidate])).values()];
  return { ok: true, choices: rank(source, candidates) };
};
