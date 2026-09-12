// [TITLE] Module: domains/system/lifecycle-registry.js
// [TITLE] Purpose: bounded ownership and deterministic shutdown for recurring runtime work

const MAX_ENTRIES = 128;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

module.exports = function createLifecycleRegistry(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const entries = new Map();
  let stopping = false;

  function register(spec = {}) {
    const owner = String(spec.owner || "").trim().toLowerCase();
    const id = String(spec.id || "").trim().toLowerCase();
    const type = String(spec.type || "work").trim().toLowerCase();
    if (!TOKEN_PATTERN.test(owner) || !TOKEN_PATTERN.test(id) || !TOKEN_PATTERN.test(type)) {
      throw new Error("lifecycle owner, id, and type must be bounded tokens");
    }
    if (typeof spec.stop !== "function") throw new Error("lifecycle work requires a stop hook");
    const key = `${owner}:${id}`;
    if (stopping) throw new Error("lifecycle registry is stopping");
    if (entries.has(key)) throw new Error(`lifecycle work already registered: ${key}`);
    if (entries.size >= MAX_ENTRIES) throw new Error(`lifecycle registry limit reached: ${MAX_ENTRIES}`);
    entries.set(key, {
      owner,
      id,
      type,
      startedAt: Number(now()),
      deadlineAt: Number.isFinite(spec.deadlineAt) ? Number(spec.deadlineAt) : null,
      stop: spec.stop
    });
    return () => entries.delete(key);
  }

  function snapshot() {
    return [...entries.values()].map(({ owner, id, type, startedAt, deadlineAt }) => ({
      owner,
      id,
      type,
      startedAt,
      deadlineAt
    }));
  }

  async function stopAll() {
    if (stopping && entries.size === 0) return [];
    stopping = true;
    const ordered = [...entries.entries()].reverse();
    const results = [];
    for (const [key, entry] of ordered) {
      try {
        await entry.stop();
        results.push({ owner: entry.owner, id: entry.id, ok: true });
      } catch (error) {
        results.push({ owner: entry.owner, id: entry.id, ok: false, error: String(error?.message || error).slice(0, 160) });
      } finally {
        entries.delete(key);
      }
    }
    return results;
  }

  return Object.freeze({ register, snapshot, stopAll });
};

module.exports.MAX_ENTRIES = MAX_ENTRIES;
