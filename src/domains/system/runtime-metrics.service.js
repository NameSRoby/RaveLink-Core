// [TITLE] Module: domains/system/runtime-metrics.service.js
// [TITLE] Purpose: bounded, redacted, low-overhead core runtime instrumentation

const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

const MAX_ROUTE_KEYS = 24;
const MAX_ROUTE_SAMPLES = 10;

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function routeKey(req) {
  const method = String(req.method || "GET").toUpperCase().slice(0, 8);
  const template = typeof req.route?.path === "string" ? req.route.path : "static-or-unmatched";
  return `${method} ${template}`.slice(0, 120);
}

function routeOwner(req) {
  const requestPath = String(req.path || req.originalUrl || "");
  return requestPath === "/mods" || requestPath.startsWith("/mods/") || requestPath.startsWith("/mods-ui/") || requestPath.startsWith("/api/mod-platform")
    ? "mod-platform"
    : "core";
}

module.exports = function createRuntimeMetricsService(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const memoryUsage = options.memoryUsage || process.memoryUsage.bind(process);
  const cpuUsage = options.cpuUsage || process.cpuUsage.bind(process);
  const resourceInfo = options.resourceInfo || (() => process.getActiveResourcesInfo?.() || []);
  const ownedWork = typeof options.ownedWork === "function" ? options.ownedWork : () => [];
  const startedAt = Date.now();
  const histogram = options.histogram || monitorEventLoopDelay({ resolution: 10 });
  histogram.enable?.();
  const routes = new Map();
  let revision = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let previousCpu = cpuUsage();
  let previousCpuAt = now();

  function observe(key, owner, durationMs, statusCode, bytes) {
    let row = routes.get(key);
    if (!row) {
      if (routes.size >= MAX_ROUTE_KEYS) key = "OTHER";
      row = routes.get(key);
      if (!row) {
        row = { owner, count: 0, errors: 0, bytes: 0, peakMs: 0, samples: [] };
        routes.set(key, row);
      }
    }
    row.count += 1;
    row.errors += Number(statusCode) >= 400 ? 1 : 0;
    row.bytes += Math.max(0, Number(bytes) || 0);
    row.peakMs = Math.max(row.peakMs, durationMs);
    row.samples.push(durationMs);
    if (row.samples.length > MAX_ROUTE_SAMPLES) row.samples.shift();
    revision += 1;
  }

  function requestMiddleware() {
    return (req, res, next) => {
      const began = now();
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        inFlight = Math.max(0, inFlight - 1);
        observe(routeKey(req), routeOwner(req), Math.max(0, now() - began), res.statusCode, res.getHeader?.("content-length"));
      };
      res.once("finish", finish);
      res.once("close", finish);
      next();
    };
  }

  function cpuSnapshot() {
    const at = now();
    const elapsedMs = Math.max(1, at - previousCpuAt);
    const currentCpu = cpuUsage();
    const usage = {
      user: Math.max(0, Number(currentCpu.user || 0) - Number(previousCpu.user || 0)),
      system: Math.max(0, Number(currentCpu.system || 0) - Number(previousCpu.system || 0))
    };
    previousCpu = currentCpu;
    previousCpuAt = at;
    return round(((Number(usage.user || 0) + Number(usage.system || 0)) / 1000) / elapsedMs * 100);
  }

  function snapshot() {
    const memory = memoryUsage();
    const activeResources = {};
    for (const name of resourceInfo().map(String).sort().slice(0, 256)) {
      const key = name.slice(0, 48);
      if (Object.keys(activeResources).length >= 32 && !(key in activeResources)) continue;
      activeResources[key] = (activeResources[key] || 0) + 1;
    }
    const routeRows = [...routes.entries()].map(([key, row]) => ({
      route: key,
      owner: row.owner,
      count: row.count,
      errors: row.errors,
      bytes: row.bytes,
      currentSamples: row.samples.length,
      p50Ms: round(percentile(row.samples, 0.5)),
      p95Ms: round(percentile(row.samples, 0.95)),
      peakMs: round(row.peakMs)
    }));
    return {
      ok: true,
      schemaVersion: 1,
      revision,
      owner: "core",
      process: {
        pid: process.pid,
        uptimeSeconds: round(process.uptime()),
        startedAt,
        cpuPercentSinceLastSample: cpuSnapshot(),
        rssMiB: round(memory.rss / 1048576),
        heapUsedMiB: round(memory.heapUsed / 1048576),
        heapTotalMiB: round(memory.heapTotal / 1048576),
        externalMiB: round(memory.external / 1048576),
        inFlightRequests: inFlight,
        peakInFlightRequests: peakInFlight,
        childProcesses: Object.entries(activeResources).reduce((sum, [name, count]) => (
          name.toLowerCase() === "processwrap" ? sum + Number(count || 0) : sum
        ), 0),
        activeResources,
        ownedWork: ownedWork().slice(0, 128)
      },
      eventLoop: {
        p50Ms: round(Number(histogram.percentile?.(50) || 0) / 1e6),
        p95Ms: round(Number(histogram.percentile?.(95) || 0) / 1e6),
        maxMs: round(Number(histogram.max || 0) / 1e6)
      },
      instrumentation: {
        routeKeys: routes.size,
        retainedLatencySamples: routeRows.reduce((sum, row) => sum + row.currentSamples, 0),
        maximumRouteKeys: MAX_ROUTE_KEYS + 1,
        maximumSamplesPerRoute: MAX_ROUTE_SAMPLES,
        recurringTimers: 0
      },
      routes: routeRows
    };
  }

  function shutdown() { histogram.disable?.(); }

  return Object.freeze({ requestMiddleware, shutdown, snapshot });
};

module.exports.MAX_ROUTE_KEYS = MAX_ROUTE_KEYS;
module.exports.MAX_ROUTE_SAMPLES = MAX_ROUTE_SAMPLES;
module.exports.percentile = percentile;
module.exports.routeKey = routeKey;
module.exports.routeOwner = routeOwner;
