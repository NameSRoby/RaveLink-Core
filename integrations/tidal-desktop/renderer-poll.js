(function startCompanion() {
  if (globalThis.__ravelinkTidalPolling || !globalThis.__ravelinkTidalBridge) return;
  globalThis.__ravelinkTidalPolling = true;
  const unloads = new Set(); let stopped = false, timer;
  const adapter = createAdapter(globalThis.__ravelinkTidal.redux, unloads, { isStopped: () => stopped });
  const companionId = crypto.randomUUID();
  addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); for (const unload of unloads) unload(); unloads.clear(); });
  async function tick() {
    try {
      const reply = await globalThis.__ravelinkTidalBridge.call('next', { companionId, ready: globalThis.__ravelinkTidal.ready(), queueReady: adapter.ready(), moderationReady: adapter.canRemove(), volumeReady: adapter.canSetVolume(), queue: adapter.queueSnapshot() });
      const command = reply.command;
      if (command && !stopped) {
        let result = { id: command.id, companionId, ok: false };
        try {
          if (Date.now() >= command.expiresAt) throw new Error('tidal_command_invalid');
          if (command.kind === 'volume') result = { ...result, ok: true, ...await adapter.setVolume(command.percent, command.expiresAt) };
          else if (!/^[1-9][0-9]{0,19}$/.test(command.trackId)) throw new Error('tidal_command_invalid');
          else if (command.kind === 'resolve') result = { ...result, ok: true, candidate: await adapter.resolve(command.trackId) };
          else if (command.kind === 'append') result = { ...result, ok: true, ...await adapter.append(command.trackId, command.expiresAt) };
          else if (command.kind === 'remove') result = { ...result, ok: true, ...await adapter.remove(command.targets, command.expiresAt) };
        } catch (error) { result.error = String(error?.message || '').slice(0, 80); if (typeof error.writeAttempted === 'boolean') result.writeAttempted = error.writeAttempted; }
        if (!stopped) await globalThis.__ravelinkTidalBridge.call('result', result);
      }
    } catch { /* Core offline or unpaired: stay isolated from TIDAL playback. */ }
    if (!stopped) timer = setTimeout(tick, 2000);
  }
  void tick();
})();
