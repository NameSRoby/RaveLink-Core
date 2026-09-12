const clients = new Map();
let stream = null, snapshot = null;

function remove(port) {
  clients.delete(port);
  port.close();
  if (!clients.size) { stream?.close(); stream = null; snapshot = null; }
}

function deliver(client, message) {
  // One unacknowledged message per port; slow clients cannot build an unbounded browser queue.
  if (client.busy) {
    if (client.queue.length >= 8) {
      client.port.postMessage({ type: 'error', error: 'feature_event_client_too_slow' });
      remove(client.port);
    } else client.queue.push(message);
    return;
  }
  client.busy = true;
  client.port.postMessage(message);
}

function broadcast(message) {
  for (const client of clients.values()) {
    if (message.type === 'lifecycle' && !client.lifecycle) continue;
    if (message.type === 'feature' && (message.value.featureId !== client.featureId || !client.capabilities.has(message.value.capability))) continue;
    deliver(client, message);
  }
}

function connect() {
  if (stream) return;
  stream = new EventSource('/api/features-stream');
  stream.onopen = () => broadcast({ type: 'resync' });
  for (const type of ['lifecycle', 'feature']) stream.addEventListener(type, event => {
    try {
      const value = JSON.parse(event.data);
      if (type === 'lifecycle') snapshot = value;
      broadcast({ type, value });
    } catch {}
  });
}

self.onconnect = event => {
  const port = event.ports[0];
  if (clients.size >= 64) { port.postMessage({ type: 'error', error: 'feature_event_client_limit' }); port.close(); return; }
  const client = { port, busy: false, queue: [], lifecycle: false, featureId: '', capabilities: new Set() };
  clients.set(port, client);
  port.onmessage = event => {
    const message = event.data;
    if (message?.type === 'close') { remove(port); return; }
    if (message?.type === 'ack') {
      client.busy = false;
      if (client.queue.length) deliver(client, client.queue.shift());
      return;
    }
    if (message?.type !== 'subscribe' || client.subscribed) return;
    client.subscribed = true;
    client.lifecycle = message.lifecycle === true;
    client.featureId = /^[a-z][a-z0-9-]{1,63}$/.test(message.featureId) ? message.featureId : '';
    client.capabilities = new Set(Array.isArray(message.capabilities) ? message.capabilities.filter(value => typeof value === 'string' && value.length <= 100).slice(0, 32) : []);
    if (snapshot && client.lifecycle) deliver(client, { type: 'lifecycle', value: snapshot });
    if (stream?.readyState === 1) deliver(client, { type: 'resync' });
    connect();
  };
  port.onmessageerror = () => remove(port);
  port.start();
};
