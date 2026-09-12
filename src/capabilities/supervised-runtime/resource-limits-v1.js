const RESOURCE_LIMITS = Object.freeze({
  idleCpuPercent: [0, 0.25, "number"],
  idleRssMiB: [8, 64, "integer"],
  activeRssMiB: [8, 192, "integer"],
  timers: [0, 8, "integer"],
  minTimerMs: [1000, 86400000, "integer"],
  ipcFrameBytes: [1024, 65536, "integer"],
  inFlightCalls: [1, 4, "integer"],
  queuedCalls: [0, 32, "integer"],
  externalInFlight: [0, 2, "integer"],
  storageBytes: [0, 8388608, "integer"],
  historyEntries: [0, 250, "integer"],
  shutdownGraceMs: [100, 3000, "integer"]
});

module.exports = { RESOURCE_LIMITS };
