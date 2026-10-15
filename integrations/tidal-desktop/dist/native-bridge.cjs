const fs = require('node:fs');
exports.createNativeBridge = function createNativeBridge(config, fetchImpl = fetch) {
  const base = new URL(config.coreUrl || 'http://127.0.0.1:5050');
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('tidal_core_url_invalid');
  return { async call(method, payload) {
    if (!['next', 'result'].includes(method) || !payload || typeof payload !== 'object') throw new Error('tidal_method_invalid');
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 16384) throw new Error('tidal_payload_too_large');
    const stat = fs.lstatSync(config.pairingFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('tidal_pairing_invalid');
    const pairing = JSON.parse(fs.readFileSync(config.pairingFile, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(pairing.token || '')) throw new Error('tidal_pairing_invalid');
    const response = await fetchImpl(new URL('/experimental/tidal/bridge/' + method, base), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + pairing.token },
      body: serialized, signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 65536) throw new Error('tidal_reply_too_large'); chunks.push(Buffer.from(chunk)); }
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || !reply.ok) throw new Error(reply.error || 'tidal_core_unavailable');
    return reply;
  } };
};
