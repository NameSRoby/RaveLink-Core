// One bounded delivery worker, independent of playback start/end observations.
module.exports = function createTidalDelivery({ entries, provider, send, updated }) {
  const held = new Map();
  let work = null, stopped = false, lastError = '';
  const errorCode = value => /^tidal_[a-z0-9_]+$/.test(String(value)) ? String(value).slice(0, 120) : 'tidal_delivery_failed';
  async function run() {
    try {
      const installation = await provider('manage-companion', { action: 'status' });
      if (installation.installed && !/^0\.1\.(\d+)$/.test(installation.version)
        || installation.installed && Number(installation.version.split('.')[2]) < 5) {
        lastError = 'tidal_companion_update_required'; return;
      }
      lastError = '';
      for (let count = 0; count < 200 && !stopped; count++) {
        const status = await provider('status', null);
        if (!status.enabled || !status.connected || !status.ready) return;
        if (!status.capacity?.reported || status.capacity.available < 1) return;
        const entry = entries().find(row => !held.has(row.id));
        if (!entry) return;
        const previous = status.handoffs?.find(row => row.entryId === entry.id);
        const waitingForSlot = previous?.phase === 'failed' && previous.lastError === 'tidal_native_queue_full';
        if (previous && ['unknown', 'pending', 'failed'].includes(previous.phase) && !waitingForSlot) {
          held.set(entry.id, previous.phase === 'unknown' ? 'tidal_handoff_needs_review' : 'tidal_delivery_retry_required'); continue;
        }
        held.set(entry.id, 'tidal_delivery_in_progress');
        let result;
        try { result = await send(entry, true); }
        catch (error) { result = { ok: false, error: errorCode(error.code || error.message) }; }
        if (stopped) return;
        if (result.error === 'tidal_native_queue_full') { held.delete(entry.id); return; }
        if (result.ok && result.removedFromRavelinkQueue) held.delete(entry.id);
        else held.set(entry.id, errorCode(result.error));
      }
    } catch (error) { lastError = errorCode(error.code || error.message); }
  }
  return {
    status: () => ({ automatic: true, processing: Boolean(work), lastError }),
    error: id => held.get(id) || '',
    release: id => held.delete(id),
    hold: (id, error) => held.set(id, errorCode(error)),
    trigger() {
      if (!stopped && !work) {
        const active = new Set(entries().map(row => row.id));
        for (const id of held.keys()) if (!active.has(id)) held.delete(id);
        if (!active.size) return { ok: true, ...this.status() };
        work = Promise.resolve().then(run).finally(() => { work = null; if (!stopped) updated?.(); });
      }
      return { ok: true, ...this.status() };
    },
    settled: () => work,
    stop() { stopped = true; }
  };
};
