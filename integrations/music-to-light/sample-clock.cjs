/** One private-pipe clock exchange bounds where the native QPC sample lies on
 * the parent's monotonic timeline. Freshness uses the oldest possible time,
 * rather than pretending local pipe delivery has zero latency. No bulb delays.
 */
const crypto = require("node:crypto");
const fault = (code) => Object.assign(new Error(code), { code });
function createClock({ generation, now }) {
  let request = null,
    anchor = null;
  return {
    request() {
      if (request) throw fault("audio_clock_repeated");
      request = { sent: now(), nonce: crypto.randomBytes(16).toString("hex") };
      return JSON.stringify({ type: "sync", generation, nonce: request.nonce }) + "\n";
    },
    accept(event) {
      if (!request || anchor || event.nonce !== request.nonce) throw fault("audio_clock_unmatched");
      const received = now(),
        rtt = received - request.sent;
      if (!Number.isFinite(rtt) || rtt < 0 || rtt > 100) throw fault("audio_clock_uncertain");
      anchor = { sent: request.sent, qpc: BigInt(event.qpc100ns), rtt };
    },
    age(qpcEnd) {
      if (!anchor || qpcEnd === null)
        return { verified: false, maxAgeMs: null, uncertaintyMs: null, stale: true };
      const delta = BigInt(qpcEnd) - anchor.qpc;
      // The anchor is intentionally valid for the whole continuous capture.
      // Compare clock disagreement, not time since synchronization: bounding
      // delta alone incorrectly ended every healthy session after 150 seconds.
      const elapsed = now() - anchor.sent;
      const expected = BigInt(Math.round(elapsed * 10000));
      const disagreement = delta - expected;
      if (disagreement > 1_500_000_000n || disagreement < -1_500_000_000n)
        throw fault("audio_clock_epoch_mismatch");
      const maxAge = elapsed - Number(delta) / 10000;
      if (maxAge < -20) throw fault("audio_timestamp_in_future");
      return {
        verified: true,
        maxAgeMs: Math.max(0, maxAge),
        uncertaintyMs: anchor.rtt,
        stale: maxAge > 250,
      };
    },
  };
}
module.exports = { createClock };
