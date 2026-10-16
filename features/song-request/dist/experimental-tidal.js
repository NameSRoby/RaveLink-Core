module.exports = function createExperimentalTidal({ queue, context, changed, isSelected = async () => true }) {
  const inFlight = new Map();
  let moderating = false;
  const entries = () => {
    if (moderating) return [];
    const first = queue.status({ limit: 25 }), rows = [...first.queue];
    for (let offset = 25; offset < Math.min(200, first.counts.queued); offset += 25) rows.push(...queue.status({ offset, limit: 25 }).queue);
    return rows.filter(row => row.candidate.provider === 'tidal');
  };
  const provider = (method, payload) => context.callCapability('tidal.desktop.experimental.v1', method, payload, { timeoutMs: method === 'resolve' ? 20000 : 10000 });
  let stopped = false;
  const delivery = require('./tidal-delivery')({ entries, provider, send, isSelected, updated: () => changed({ ok: true, code: 'tidal_delivery_changed' }) });
  const moderate = require('./tidal-moderation')({ queue, provider, changed, waitForDelivery: () => Promise.allSettled([...inFlight.values()]) });
  async function send(entry, automatic = false) {
    if (!await isSelected()) return { ok: false, error: 'player_inactive' };
    if (inFlight.has(entry.id)) return { ok: false, error: 'tidal_handoff_in_progress' };
    try {
      const operation = provider('enqueue', { entryId: entry.id, trackId: entry.candidate.providerItemId, candidate: entry.candidate, automatic,
        requesterKey: entry.requesterKey, requesterLabel: entry.requesterLabel, requesterRole: entry.requesterRole });
      inFlight.set(entry.id, operation);
      const result = await operation;
      if (!result?.ok || result.appended !== true || stopped) return result;
      const settled = queue.settle({ entryId: entry.id, outcome: 'handed_off' });
      if (settled.ok) changed(settled);
      return { ...result, entryId: entry.id, outcome: 'handed_off', removedFromRavelinkQueue: settled.ok,
        warning: settled.ok ? '' : 'Queue changed during handoff; TIDAL append was confirmed. Do not replay.' };
    } finally { inFlight.delete(entry.id); }
  }
  async function handle(method, payload = {}) {
    if (method === 'moderate') {
      if (moderating) return { ok: false, code: 'rejected', reason: 'tidal_moderation_busy' };
      const waiting = entries(); moderating = true;
      try { return await moderate(payload, waiting); }
      finally { moderating = false; delivery.trigger(); }
    }
    if (method === 'catalog') return provider('catalog', payload);
    if (method === 'companion') return provider('manage-companion', payload);
    if (method === 'volume') return provider('volume', payload);
    if (method === 'flush') {
      if (payload.nativeQueueChanged) changed({ ok: true, code: 'tidal_native_queue_changed' });
      return delivery.trigger();
    }
    if (method === 'enable') {
      try { return await provider('enable', {}); } catch { return { ok: false, error: 'tidal_experiment_unavailable' }; }
    }
    let status;
    try { status = await provider('status', null); }
    catch { return { ok: false, error: 'tidal_experiment_disabled' }; }
    if (method === 'status') { const waiting = entries(); return { ...status, waiting: waiting.length, delivery: delivery.status(), queue: waiting.slice(0, 10).map(row => ({ ...row, deliveryError: delivery.error(row.id) })) }; }
    if (!status?.enabled) return { ok: false, error: 'tidal_experiment_disabled' };
    if (method === 'review') return provider('review', payload);
    if (method === 'monitor') {
      const selected = await context.callCapability('media.windows.now-playing.v1', 'control', { action: 'select', provider: 'tidal' }, { timeoutMs: 2000 });
      if (!selected.ok) return selected;
      const started = await context.callCapability('media.windows.now-playing.v1', 'control', { action: 'start' }, { timeoutMs: 2000 });
      if (started.ok) { const result = queue.configurePlaybackSource({ source: 'tidal' }); changed(result); }
      return started;
    }
    if (method === 'submit') return submit({ ...payload, requesterId: 'local-tidal-operator', requesterName: 'Local TIDAL operator', requesterRole: 'moderator' });
    if (method !== 'handoff') return { ok: false, error: 'tidal_method_invalid' };
    const entry = entries().find(row => row.id === payload.entryId);
    if (!entry) return { ok: false, error: 'tidal_entry_not_found' };
    if (delivery.status().processing) return { ok: false, error: 'tidal_handoff_in_progress' };
    delivery.release(entry.id);
    const result = await send(entry);
    if (!result.ok) delivery.hold(entry.id, result.error);
    return result;
  }
  async function submit(payload) {
    if (!await isSelected()) return { ok: false, code: 'rejected', reason: 'player_inactive' };
      const state = queue.status();
      const resolved = await provider('resolve', { query: payload.query,
        policy: { ...state.catalogPolicy, maxDurationMs: state.limits.maxDurationMs } });
      if (!resolved?.ok) return resolved;
      if (!await isSelected()) return { ok: false, code: 'rejected', reason: 'player_inactive' };
      const result = queue.submit({ requestId: payload.requestId, requesterId: payload.requesterId, requesterName: payload.requesterName,
        requesterRole: payload.requesterRole, query: payload.query, candidate: resolved.candidate });
      if (result.ok) { changed(result); delivery.trigger(); }
      if (!result.ok && result.reason === 'duration_limit') return { ...result,
        details: { title: resolved.candidate.title, durationMs: resolved.candidate.durationMs, maxDurationMs: queue.status().limits.maxDurationMs } };
      return result;
  }
  handle.submit = submit;
  handle.stop = () => { stopped = true; delivery.stop(); };
  return handle;
};
