/** Server-owned fixture leases. No audio code, credentials, polling or global
 * timer on import. Read/write/restore are injected server adapters, all serialized
 * through one fixture lane. See docs/DEVELOPMENT.md#fixture-output-ownership.
 */
const crypto = require("node:crypto");
const createQueue = require("./fixture-output-queue");
const normalizeState = require("./fixture-output-state");
const fault = (code) => Object.assign(new Error(code), { code });

module.exports = function createFixtureOutputOwnership({
  readState,
  writeState,
  restoreState,
  isEligible,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maximum = 128,
  timeoutMs = 2000,
} = {}) {
  if ([readState, writeState, restoreState, isEligible].some((fn) => typeof fn !== "function"))
    throw fault("fixture_output_dependencies_required");
  const queue = createQueue({ maximum, timeoutMs }),
    slots = new Map(),
    tokens = new Map();
  let timer = null,
    closed = false,
    shutdownPromise = null,
    lastFault = null;
  function report(error, id) {
    lastFault = { fixtureId: id, code: error?.code || "fixture_output_failed" };
  }
  function fixtureId(id) {
    if (typeof id !== "string" || !id || id.length > 256 || !isEligible(id))
      throw fault("fixture_not_eligible");
    return id;
  }
  function duration(ttl) {
    if (!Number.isInteger(ttl) || ttl < 250 || ttl > 60000)
      throw fault("invalid_fixture_lease_duration");
    return ttl;
  }
  function current(slot) {
    return (
      [...slot.layers.values()]
        .filter((l) => l.ready && l.expiresAt > now())
        .sort((a, b) => (b.kind === "effect" ? 20 : 10) - (a.kind === "effect" ? 20 : 10))[0] ||
      null
    );
  }
  function slotFor(id) {
    let slot = slots.get(id);
    if (!slot) {
      if (slots.size >= maximum) throw fault("fixture_lease_limit");
      slot = {
        id,
        layers: new Map(),
        baseline: null,
        capture: null,
        manual: null,
        manualRevision: 0,
        generation: 0,
      };
      slots.set(id, slot);
    }
    return slot;
  }
  function drop(slot, lease) {
    if (slot.layers.get(lease.kind) === lease) slot.layers.delete(lease.kind);
    tokens.delete(lease.token);
  }
  function cleanup(slot, generation) {
    if (!slot.layers.size && slot.generation === generation && slots.get(slot.id) === slot)
      slots.delete(slot.id);
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (closed) return;
    const deadlines = [...tokens.values()].filter((l) => l.ready).map((l) => l.expiresAt);
    if (!deadlines.length) return;
    timer = setTimer(
      () => {
        timer = null;
        void expire().catch((error) => report(error, ""));
      },
      Math.max(0, Math.min(...deadlines) - now()),
    );
    timer?.unref?.();
  }
  function tokenLease(token) {
    const lease = tokens.get(token);
    if (!lease || !lease.ready || lease.expiresAt <= now() || !isEligible(lease.slot.id))
      throw fault("fixture_lease_expired_or_replaced");
    return lease;
  }
  function receipt(value) {
    if (!value || value.sent !== 1 || value.failed > 0) throw fault("fixture_delivery_unconfirmed");
    const result = { sent: 1, failed: 0, dryRun: value.dryRun === true };
    // Preserve the existing command-preview contract without passing through
    // arbitrary adapter metadata (URLs, target objects or credentials).
    const command = value.command;
    if (command?.method === "setPilot" && typeof command.params?.state === "boolean") {
      const { state, ...fields } = command.params;
      const { on, ...native } = normalizeState({ ...fields, on: state });
      result.command = { method: "setPilot", params: { state: on, ...native } };
    } else if (command?.method === "PUT" && command.resource === "light-state") {
      result.command = {
        method: "PUT",
        resource: "light-state",
        body: normalizeState(command.body),
      };
    }
    return result;
  }
  function captureBaseline(slot) {
    if (slot.baseline) return Promise.resolve(slot.baseline);
    if (slot.capture) return slot.capture;
    let capture;
    capture = Promise.resolve(slot.manual)
      .then(() =>
        queue.submit(
          slot.id,
          () => readState(slot.id),
          () =>
            slots.get(slot.id) === slot &&
            slot.capture === capture &&
            slot.layers.size > 0 &&
            isEligible(slot.id),
        ),
      )
      .then((result) => {
        if (result?.suppressed || result?.ok !== true) throw fault("fixture_baseline_unavailable");
        const state = normalizeState(result.state, true);
        if (slots.get(slot.id) !== slot || slot.capture !== capture || !slot.layers.size)
          throw fault("fixture_capture_superseded");
        slot.baseline = state;
        return state;
      });
    slot.capture = capture;
    return capture;
  }
  async function acquire({ fixtureId: id, owner, kind, ttlMs = 5000, replaceToken } = {}) {
    if (closed) throw fault("fixture_output_closed");
    fixtureId(id);
    duration(ttlMs);
    if (
      typeof owner !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,96}$/.test(owner) ||
      !["music", "effect"].includes(kind)
    )
      throw fault("invalid_fixture_owner");
    const slot = slotFor(id),
      previous = slot.layers.get(kind);
    const startingState = current(slot)?.latest?.state;
    if (replaceToken && previous?.token !== replaceToken)
      throw fault("fixture_lease_replacement_stale");
    if (previous && previous.expiresAt > now() && (!replaceToken || previous.owner !== owner))
      throw fault("fixture_already_owned");
    if (previous) drop(slot, previous);
    const lease = {
      token: crypto.randomUUID(),
      slot,
      owner,
      kind,
      ttlMs,
      expiresAt: Infinity,
      ready: false,
      latest: null,
    };
    slot.layers.set(kind, lease);
    tokens.set(lease.token, lease);
    slot.generation++;
    try {
      const baseline = await captureBaseline(slot);
      if (closed || tokens.get(lease.token) !== lease || !isEligible(id))
        throw fault("fixture_capture_superseded");
      lease.ready = true;
      lease.expiresAt = now() + ttlMs;
      schedule();
      return {
        token: lease.token,
        baseline: structuredClone(baseline),
        startingState: structuredClone({ ...baseline, ...startingState }),
      };
    } catch (error) {
      drop(slot, lease);
      cleanup(slot, slot.generation);
      schedule();
      throw error;
    }
  }
  // Trusted Core callers share an owner namespace for temporary programs. Reserve
  // replacement synchronously, including while the first baseline read is pending.
  // This is not an HTTP/feature capability: external callers must use token-bound
  // acquire instead. A different owner can never be replaced through this method.
  function replaceOwned(input = {}) {
    const previous = slots.get(input.fixtureId)?.layers.get(input.kind);
    if (previous && previous.owner !== input.owner)
      return Promise.reject(fault("fixture_already_owned"));
    return acquire({ ...input, replaceToken: previous?.token });
  }
  function fresh(lease) {
    return (
      !lease.restoring &&
      lease.latest &&
      (lease.kind !== "music" || now() - lease.latest.sampledAt <= 250)
    );
  }
  async function write(token, state, { sampledAt } = {}) {
    if (closed) throw fault("fixture_output_closed");
    const lease = tokenLease(token),
      slot = lease.slot;
    const value = normalizeState(state);
    if (
      lease.kind === "music" &&
      (!Number.isFinite(sampledAt) || now() - sampledAt > 250 || sampledAt - now() > 20)
    )
      throw fault("stale_music_intent");
    lease.latest = { state: value, sampledAt };
    lease.expiresAt = now() + lease.ttlMs;
    schedule();
    if (current(slot) !== lease) return { sent: 0, failed: 0, suspended: true };
    const result = await queue.submit(
      slot.id,
      () => {
        if (!fresh(lease)) return { suppressed: true };
        return writeState(slot.id, structuredClone(lease.latest.state));
      },
      () =>
        slots.get(slot.id) === slot &&
        tokens.get(token) === lease &&
        current(slot) === lease &&
        isEligible(slot.id),
    );
    return result?.suppressed ? { sent: 0, failed: 0, suppressed: true } : receipt(result);
  }
  async function settle(slot, generation) {
    try {
      const result = await queue.submit(
        slot.id,
        async () => {
          const top = current(slot);
          if (top && fresh(top))
            return receipt(await writeState(slot.id, structuredClone(top.latest.state)));
          if (!slot.baseline) return { suppressed: true };
          return receipt(await restoreState(slot.id, structuredClone(slot.baseline)));
        },
        () => slots.get(slot.id) === slot && slot.generation === generation && isEligible(slot.id),
      );
      return result?.suppressed ? { sent: 0, failed: 0, suppressed: true } : result;
    } catch (error) {
      report(error, slot.id);
      return { sent: 0, failed: 1, code: error.code || "fixture_restore_failed" };
    } finally {
      cleanup(slot, generation);
    }
  }
  async function release(token, { restore = true } = {}) {
    const lease = tokens.get(token);
    if (!lease) return { sent: 0, failed: 0, suppressed: true };
    const slot = lease.slot,
      wasTop = current(slot) === lease || lease.kind === "effect";
    drop(slot, lease);
    const generation = ++slot.generation;
    schedule();
    if (!wasTop && slot.layers.size) return { sent: 0, failed: 0, suppressed: true };
    if (!restore) {
      for (const remaining of slot.layers.values()) tokens.delete(remaining.token);
      slot.layers.clear();
      cleanup(slot, generation);
      return { sent: 0, failed: 0, held: true };
    }
    if (!slot.baseline) {
      cleanup(slot, generation);
      return { sent: 0, failed: 0, suppressed: true };
    }
    return settle(slot, generation);
  }
  async function animateReturn(
    owner,
    { fadeMs = 0, style = 1, fixtureOrder = [], maxHz = 16 } = {},
  ) {
    if (!Number.isInteger(fadeMs) || fadeMs < 0 || fadeMs > 4000 || ![1, 2].includes(style))
      throw fault("invalid_fixture_return_animation");
    if (
      !Array.isArray(fixtureOrder) ||
      fixtureOrder.length > 128 ||
      fixtureOrder.some((id) => typeof id !== "string" || id.length > 256)
    )
      throw fault("invalid_fixture_return_animation");
    if (!Number.isFinite(maxHz) || maxHz < 1 || maxHz > 16)
      throw fault("invalid_fixture_return_animation");
    if (!fadeMs || closed) return;
    const rows = [...tokens.values()].filter(
      (lease) => lease.owner === owner && lease.latest && current(lease.slot) === lease,
    );
    rows.sort((a, b) => fixtureOrder.indexOf(a.slot.id) - fixtureOrder.indexOf(b.slot.id));
    if (!rows.length) return;
    const failures = [];
    const hueCount = rows.filter((lease) => "bri" in lease.slot.baseline).length;
    const rate = Math.min(maxHz, hueCount ? 8 / hueCount : 16);
    const steps = Math.floor((fadeMs * rate) / 1000);
    if (steps < 2) return; // Too few paced samples: exact restoration is clearer.
    const { interpolate } = require("./fixture-output-transition");
    const starts = new Map(rows.map((lease) => [lease.token, structuredClone(lease.latest.state)]));
    rows.forEach((lease) => {
      lease.restoring = true;
    });
    const began = now();
    for (let step = 1; step <= steps && !closed; step++) {
      if (!rows.some((lease) => tokens.get(lease.token) === lease && current(lease.slot) === lease))
        break;
      // Restoration is server choreography, not fabricated fresh audio. Leases
      // remain fenced by token/current owner and bounded by the normal TTL.
      rows.forEach((lease) => {
        if (tokens.get(lease.token) === lease) lease.expiresAt = now() + lease.ttlMs;
      });
      schedule();
      await new Promise((resolve) => setTimeout(resolve, fadeMs / steps));
      const progress = Math.min(1, Math.max(step / steps, (now() - began) / fadeMs));
      if (progress >= 1 || closed) break;
      await Promise.all(
        rows.map(async (lease, index) => {
          const slot = lease.slot;
          const eligible = () =>
            !closed &&
            tokens.get(lease.token) === lease &&
            current(slot) === lease &&
            isEligible(slot.id);
          if (!eligible()) return;
          try {
            await queue.submit(
              slot.id,
              async () => {
                // A lower live music layer can move throughout an effect's ending.
                // Return toward its current fresh intent; otherwise the true baseline.
                const lower = [...slot.layers.values()].find(
                  (layer) =>
                    layer !== lease && layer.ready && layer.expiresAt > now() && fresh(layer),
                );
                const target = lower?.latest.state || slot.baseline;
                const offset = style === 2 ? (0.3 * index) / Math.max(1, rows.length - 1) : 0;
                const t = Math.max(0, (progress - offset) / (1 - offset));
                return receipt(
                  await writeState(slot.id, interpolate(starts.get(lease.token), target, t)),
                );
              },
              eligible,
            );
          } catch (error) {
            report(error, slot.id);
            failures.push({ sent: 0, failed: 1, code: error.code || "fixture_return_failed" });
          }
        }),
      );
    }
    return failures;
  }
  async function releaseOwner(owner, animation) {
    const animationFailures = await animateReturn(owner, animation);
    const affected = new Set();
    for (const lease of [...tokens.values()])
      if (lease.owner === owner) {
        drop(lease.slot, lease);
        lease.slot.generation++;
        affected.add(lease.slot);
      }
    schedule();
    return [
      ...(animationFailures || []),
      ...(await Promise.all([...affected].map((slot) => settle(slot, slot.generation)))),
    ];
  }
  async function expire() {
    const affected = new Set();
    for (const lease of [...tokens.values()])
      if (lease.ready && lease.expiresAt <= now()) {
        drop(lease.slot, lease);
        lease.slot.generation++;
        affected.add(lease.slot);
      }
    schedule();
    return Promise.all([...affected].map((slot) => settle(slot, slot.generation)));
  }
  async function manualWrite(id, state) {
    if (closed) throw fault("fixture_output_closed");
    fixtureId(id);
    const value = normalizeState(state),
      slot = slotFor(id);
    for (const lease of slot.layers.values()) tokens.delete(lease.token);
    slot.layers.clear();
    slot.baseline = null;
    slot.capture = null;
    slot.generation++;
    const revision = ++slot.manualRevision;
    schedule();
    const operation = queue
      .submit(
        id,
        () => writeState(id, value),
        () => slots.get(id) === slot && slot.manualRevision === revision && isEligible(id),
      )
      .then((result) =>
        result?.suppressed ? { sent: 0, failed: 0, suppressed: true } : receipt(result),
      );
    slot.manual = operation;
    try {
      return await operation;
    } finally {
      cleanup(slot, slot.generation);
    }
  }
  function removeFixture(id) {
    const slot = slots.get(id);
    if (!slot) return;
    for (const lease of slot.layers.values()) tokens.delete(lease.token);
    slots.delete(id);
    schedule();
  }
  function closeAdmission() {
    closed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closeAdmission();
    const affected = [...slots.values()];
    tokens.clear();
    for (const slot of affected) {
      slot.layers.clear();
      slot.generation++;
    }
    shutdownPromise = Promise.all(affected.map((slot) => settle(slot, slot.generation)));
    return shutdownPromise;
  }
  return Object.freeze({
    acquire,
    replaceOwned,
    write,
    release,
    releaseOwner,
    manualWrite,
    removeFixture,
    expire,
    shutdown,
    closeAdmission,
    has: (token) => {
      try {
        tokenLease(token);
        return true;
      } catch {
        return false;
      }
    },
    snapshot: () => ({
      closed,
      fixtures: [...slots.values()].map((slot) => ({
        fixtureId: slot.id,
        owners: [...slot.layers.values()].map((l) => ({
          owner: l.owner,
          kind: l.kind,
          ready: l.ready,
          expiresInMs: l.ready ? Math.max(0, l.expiresAt - now()) : null,
        })),
        activeOwner: current(slot)?.owner || null,
      })),
      queue: queue.snapshot(),
      lastFault: structuredClone(lastFault),
    }),
  });
};
