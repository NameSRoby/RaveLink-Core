(() => {
  let fallbackStream;
  const fallbackListeners = new Set();
  function fallback(options, receive) {
    // Older embedded browsers share their top-level HUD connection without workers.
    try {
      if (parent !== window && parent.ravelinkFeatureEvents) return parent.ravelinkFeatureEvents.subscribe(options, receive);
    } catch {}
    const listener = message => {
      if (message.type === 'lifecycle' && !options.lifecycle) return;
      if (message.type === 'feature' && (message.value.featureId !== options.featureId || !options.capabilities?.includes(message.value.capability))) return;
      receive(message);
    };
    fallbackListeners.add(listener);
    if (!fallbackStream) {
      fallbackStream = new EventSource('/api/features-stream');
      fallbackStream.onopen = () => fallbackListeners.forEach(callback => callback({ type: 'resync' }));
      for (const type of ['lifecycle', 'feature']) fallbackStream.addEventListener(type, event => {
        try { const value = JSON.parse(event.data); fallbackListeners.forEach(callback => callback({ type, value })); } catch {}
      });
    }
    return () => {
      fallbackListeners.delete(listener);
      if (!fallbackListeners.size) { fallbackStream.close(); fallbackStream = null; }
    };
  }
  function subscribe(options, receive) {
    let close, closed = false;
    try {
      const worker = new SharedWorker('/feature-events.worker.js', { name: 'ravelink-feature-events-v1' });
      const port = worker.port;
      let failed = false;
      worker.onerror = event => {
        event.preventDefault();
        if (closed || failed) return;
        failed = true;
        port.postMessage({ type: 'close' });
        port.close();
        close = fallback(options, receive);
      };
      port.onmessage = event => {
        try { if (!closed) receive(event.data); }
        finally { if (!closed) port.postMessage({ type: 'ack' }); }
      };
      port.start();
      port.postMessage({ type: 'subscribe', ...options });
      close = () => { port.postMessage({ type: 'close' }); port.close(); };
    } catch { close = fallback(options, receive); }
    const dispose = () => {
      if (closed) return;
      closed = true;
      close();
      window.removeEventListener('pagehide', dispose);
    };
    window.addEventListener('pagehide', dispose);
    return dispose;
  }
  window.ravelinkFeatureEvents = Object.freeze({ subscribe });
})();
