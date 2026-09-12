// [TITLE] Module: app/runtime/egress-governor.js
// [TITLE] Purpose: bounded, priority-aware admission for outbound runtime work

const OWNER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_OWNERS = 16;

class EgressAdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = "EgressAdmissionError";
    this.code = code;
  }
}

module.exports = function createEgressGovernor(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const maximumConcurrent = Math.min(16, Math.max(1, Number(options.maximumConcurrent) || 4));
  const maximumQueued = Math.min(128, Math.max(0, Number(options.maximumQueued) || 32));
  const baselineBurstLimit = Math.min(32, Math.max(1, Number(options.baselineBurstLimit) || 8));
  const configuredOwners = options.ownerLimits && typeof options.ownerLimits === "object"
    ? options.ownerLimits
    : {
      "lighting.hue": 4,
      "chat.streamelements": 2,
      "mod.network": 2,
      "provider.external": 2
    };
  const ownerLimits = new Map();
  for (const [rawOwner, rawLimit] of Object.entries(configuredOwners).slice(0, MAX_OWNERS)) {
    const owner = String(rawOwner || "").trim().toLowerCase();
    if (!OWNER_PATTERN.test(owner)) continue;
    ownerLimits.set(owner, Math.min(maximumConcurrent, Math.max(1, Number(rawLimit) || 1)));
  }
  if (!ownerLimits.size) throw new Error("egress_governor_requires_owner_limits");

  const queue = [];
  const activeByOwner = new Map();
  const countersByOwner = new Map([...ownerLimits.keys()].map(owner => [owner, {
    accepted: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    expired: 0
  }]));
  let active = 0;
  let peakActive = 0;
  let baselineDispatches = 0;
  let stopping = false;
  const activeSettlements = new Set();

  function admissionError(code) {
    return new EgressAdmissionError(code);
  }

  function canRun(job) {
    return active < maximumConcurrent
      && Number(activeByOwner.get(job.owner) || 0) < Number(ownerLimits.get(job.owner) || 1);
  }

  function nextJobIndex() {
    let baseline = -1;
    let optional = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const job = queue[index];
      if (!canRun(job)) continue;
      if (job.priority === "baseline" && baseline < 0) baseline = index;
      if (job.priority === "optional" && optional < 0) optional = index;
    }
    if (optional >= 0 && (baseline < 0 || baselineDispatches >= baselineBurstLimit)) return optional;
    return baseline >= 0 ? baseline : optional;
  }

  function drain() {
    while (!stopping && active < maximumConcurrent && queue.length) {
      const index = nextJobIndex();
      if (index < 0) return;
      const [job] = queue.splice(index, 1);
      const counters = countersByOwner.get(job.owner);
      if (job.deadlineAt > 0 && Number(now()) >= job.deadlineAt) {
        counters.expired += 1;
        job.reject(admissionError("egress_queue_expired"));
        continue;
      }
      if (job.priority === "baseline") baselineDispatches += 1;
      else baselineDispatches = 0;
      active += 1;
      peakActive = Math.max(peakActive, active);
      activeByOwner.set(job.owner, Number(activeByOwner.get(job.owner) || 0) + 1);
      const settlement = Promise.resolve()
        .then(job.operation)
        .then(value => {
          counters.completed += 1;
          job.resolve(value);
        }, error => {
          counters.failed += 1;
          job.reject(error);
        })
        .finally(() => {
          active = Math.max(0, active - 1);
          const remaining = Math.max(0, Number(activeByOwner.get(job.owner) || 1) - 1);
          if (remaining) activeByOwner.set(job.owner, remaining);
          else activeByOwner.delete(job.owner);
          activeSettlements.delete(settlement);
          drain();
        });
      activeSettlements.add(settlement);
    }
  }

  function run(spec = {}, operation) {
    const owner = String(spec.owner || "").trim().toLowerCase();
    if (!ownerLimits.has(owner)) return Promise.reject(admissionError("egress_owner_unknown"));
    if (typeof operation !== "function") return Promise.reject(admissionError("egress_operation_invalid"));
    const counters = countersByOwner.get(owner);
    if (stopping) {
      counters.rejected += 1;
      return Promise.reject(admissionError("egress_shutdown"));
    }
    if (queue.length >= maximumQueued && !canRun({ owner })) {
      counters.rejected += 1;
      return Promise.reject(admissionError("egress_queue_full"));
    }
    const timeoutMs = Math.min(30000, Math.max(250, Number(spec.queueDeadlineMs) || 10000));
    counters.accepted += 1;
    return new Promise((resolve, reject) => {
      queue.push({
        owner,
        priority: spec.priority === "baseline" ? "baseline" : "optional",
        deadlineAt: Number(now()) + timeoutMs,
        operation,
        resolve,
        reject
      });
      drain();
    });
  }

  async function shutdown() {
    if (!stopping) {
      stopping = true;
      while (queue.length) {
        const job = queue.shift();
        countersByOwner.get(job.owner).rejected += 1;
        job.reject(admissionError("egress_shutdown"));
      }
    }
    await Promise.allSettled([...activeSettlements]);
  }

  function getDiagnostics() {
    return {
      ok: true,
      owner: "core.egress",
      active,
      peakActive,
      queued: queue.length,
      maximumConcurrent,
      maximumQueued,
      baselineBurstLimit,
      stopping,
      owners: [...ownerLimits.entries()].map(([owner, maximumOwnerConcurrent]) => ({
        owner,
        active: Number(activeByOwner.get(owner) || 0),
        maximumConcurrent: maximumOwnerConcurrent,
        ...countersByOwner.get(owner)
      }))
    };
  }

  return Object.freeze({ run, shutdown, getDiagnostics });
};

module.exports.EgressAdmissionError = EgressAdmissionError;
