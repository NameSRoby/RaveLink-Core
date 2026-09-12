// [TITLE] Module: capabilities/supervised-runtime/host/resource-monitor.js
// [TITLE] Purpose: host-observe supervised process CPU and RSS under one global sampler
// [TITLE] Functionality Index:
// [TITLE] - batch active Windows PIDs without profiles or per-mod polling timers
// [TITLE] - compute CPU from trusted cumulative OS process times
// [TITLE] - disable only after sustained measured resource violations

const { execFile } = require("node:child_process");

function sampleWindowsProcesses(pids) {
  const safePids = [...new Set(pids.map(Number).filter(pid => Number.isInteger(pid) && pid > 0))];
  if (!safePids.length) return Promise.resolve(new Map());
  const filter = safePids.map(pid => `ProcessId=${pid}`).join(" OR ");
  const command = `Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop | Select-Object ProcessId,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const parsed = JSON.parse(String(stdout || "null"));
        const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        resolve(new Map(rows.map(row => [Number(row.ProcessId), {
          memoryBytes: Number(row.WorkingSetSize || 0),
          cpuTimeMs: (Number(row.KernelModeTime || 0) + Number(row.UserModeTime || 0)) / 10000
        }])));
      } catch (parseError) { reject(parseError); }
    });
  });
}

module.exports = function createResourceMonitor(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sample = typeof options.sample === "function" ? options.sample : sampleWindowsProcesses;
  const onViolation = typeof options.onViolation === "function" ? options.onViolation : async () => {};
  const isIdle = typeof options.isIdle === "function" ? options.isIdle : () => true;
  const intervalMs = Math.min(300000, Math.max(15000, Number(options.intervalMs) || 60000));
  const cpuWindowMs = Math.min(600000, Math.max(30000, Number(options.cpuWindowMs) || 300000));
  const breachLimit = Math.min(10, Math.max(2, Number(options.breachLimit) || 3));
  const identityField = String(options.identityField || "workloadId");
  const collectionName = String(options.collectionName || "workloads");
  const entries = new Map();
  let timer = null;
  let sampling = false;
  let sampleErrors = 0;

  function ensureTimer() {
    if (timer || !entries.size) return;
    timer = setTimeout(async () => {
      timer = null;
      await sampleOnce();
      ensureTimer();
    }, intervalMs);
    timer.unref?.();
  }

  function register(workloadId, pid, manifest) {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return { ok: false, error: "resource_pid_invalid" };
    entries.set(String(workloadId), {
      workloadId: String(workloadId), pid: Number(pid), manifest, previous: null, samples: [], rssBreaches: 0, cpuBreaches: 0,
      lastCpuPercent: 0, lastRssMiB: 0, violation: ""
    });
    ensureTimer();
    return { ok: true };
  }

  function unregister(workloadId) {
    entries.delete(String(workloadId));
    if (!entries.size && timer) { clearTimeout(timer); timer = null; }
  }

  async function sampleOnce() {
    if (sampling || !entries.size) return { ok: true, skipped: true };
    sampling = true;
    const at = Number(now());
    try {
      const measured = await sample([...entries.values()].map(row => row.pid));
      for (const row of entries.values()) {
        const metric = measured.get(row.pid);
        if (!metric) continue;
        const rssMiB = Number(metric.memoryBytes || 0) / (1024 * 1024);
        let cpuPercent = 0;
        if (row.previous && at > row.previous.at) cpuPercent = Math.max(0, (Number(metric.cpuTimeMs) - row.previous.cpuTimeMs) / (at - row.previous.at) * 100);
        row.previous = { at, cpuTimeMs: Number(metric.cpuTimeMs || 0) };
        row.lastCpuPercent = cpuPercent;
        row.lastRssMiB = rssMiB;
        if (!isIdle(row.workloadId)) {
          row.samples.length = 0;
          row.cpuBreaches = 0;
        } else row.samples.push({ at, cpuPercent });
        while (row.samples.length && row.samples[0].at < at - cpuWindowMs) row.samples.shift();
        const rssLimit = Number(row.manifest?.resources?.activeRssMiB || 192);
        const rssTolerance = Math.max(8, rssLimit * 0.1);
        row.rssBreaches = rssMiB > rssLimit + rssTolerance ? row.rssBreaches + 1 : 0;
        const windowCovered = row.samples.length > 1 && row.samples[row.samples.length - 1].at - row.samples[0].at >= cpuWindowMs;
        const averageCpu = row.samples.reduce((sum, item) => sum + item.cpuPercent, 0) / Math.max(1, row.samples.length);
        const cpuLimit = Number(row.manifest?.resources?.idleCpuPercent || 0.25);
        row.cpuBreaches = windowCovered && averageCpu > cpuLimit + 0.1 ? row.cpuBreaches + 1 : 0;
        const violation = row.rssBreaches >= breachLimit ? "active_rss_limit" : (row.cpuBreaches >= breachLimit ? "idle_cpu_limit" : "");
        if (violation && !row.violation) {
          row.violation = violation;
          await onViolation(row.workloadId, { code: violation, rssMiB, averageCpu });
        }
      }
      return { ok: true, sampled: measured.size };
    } catch {
      sampleErrors += 1;
      return { ok: false, error: "resource_sample_failed" };
    } finally { sampling = false; }
  }

  function getStatus(workloadId) {
    const rows = workloadId ? [entries.get(String(workloadId))].filter(Boolean) : [...entries.values()];
    return {
      ok: true, active: entries.size, sampling, scheduled: Boolean(timer), sampleErrors,
      [collectionName]: rows.map(row => ({
        [identityField]: row.workloadId, pid: row.pid, rssMiB: row.lastRssMiB, cpuPercent: row.lastCpuPercent,
        limits: {
          activeRssMiB: Number(row.manifest?.resources?.activeRssMiB || 192),
          idleCpuPercent: Number(row.manifest?.resources?.idleCpuPercent || 0.25)
        },
        rssBreaches: row.rssBreaches, cpuBreaches: row.cpuBreaches, violation: row.violation
      }))
    };
  }

  function shutdown() {
    if (timer) clearTimeout(timer);
    timer = null;
    entries.clear();
  }

  return Object.freeze({ getStatus, register, sampleOnce, shutdown, unregister });
};

module.exports.sampleWindowsProcesses = sampleWindowsProcesses;
