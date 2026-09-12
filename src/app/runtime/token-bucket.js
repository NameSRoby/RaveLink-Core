// [TITLE] Module: app/runtime/token-bucket.js
// [TITLE] Purpose: bounded route-local token bucket without recurring timers

module.exports = function createTokenBucket(options = {}) {
  const capacity = Math.min(1000, Math.max(1, Number(options.capacity) || 120));
  const refillPerSecond = Math.min(1000, Math.max(0.1, Number(options.refillPerSecond) || 2));
  const maximumKeys = Math.min(256, Math.max(1, Number(options.maximumKeys) || 64));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const buckets = new Map();
  let accepted = 0;
  let rejected = 0;
  let evictions = 0;

  function take(rawKey = "default", cost = 1) {
    const key = String(rawKey || "default").slice(0, 64);
    const at = Number(now());
    let bucket = buckets.get(key);
    if (!bucket) {
      while (buckets.size >= maximumKeys) {
        buckets.delete(buckets.keys().next().value);
        evictions += 1;
      }
      bucket = { tokens: capacity, at };
      buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, at - bucket.at) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.at = at;
    const requested = Math.min(capacity, Math.max(1, Number(cost) || 1));
    if (bucket.tokens < requested) {
      rejected += 1;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((requested - bucket.tokens) / refillPerSecond)) };
    }
    bucket.tokens -= requested;
    accepted += 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  function getDiagnostics() {
    return { ok: true, keys: buckets.size, maximumKeys, capacity, refillPerSecond, accepted, rejected, evictions };
  }

  return Object.freeze({ take, getDiagnostics });
};
