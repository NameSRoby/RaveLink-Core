const createResourceMonitor = require("../../supervised-runtime/host/resource-monitor");
const { sampleWindowsProcesses } = require("../../supervised-runtime/host/resource-monitor");

module.exports = function createModResourceMonitor(options = {}) {
  return createResourceMonitor({ ...options, identityField: "modId", collectionName: "mods" });
};

module.exports.sampleWindowsProcesses = sampleWindowsProcesses;
