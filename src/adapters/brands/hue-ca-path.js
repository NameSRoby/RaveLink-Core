/**
 * Shared Hue CA certificate discovery for REST and Entertainment transports.
 * The operator override wins, then the installed optional dependency, then an
 * explicit application root. Only return an existing file candidate; each caller
 * still owns loading/trusting it for its transport. Resolving a path does not
 * disable TLS identity checks or modify an existing trust configuration.
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = function resolveSignifyPemPath(rootDir = "", options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const resolvePackage = options.resolvePackage || require.resolve;
  const candidates = [];
  const override = String(env.RAVE_HUE_CA_CERT_PATH || "").trim();
  if (override) candidates.push(override);
  try {
    candidates.push(
      path.join(path.dirname(resolvePackage("hue-sync/package.json")), "signify.pem"),
    );
  } catch {
    /* The Entertainment dependency is optional. */
  }
  if (rootDir) candidates.push(path.join(rootDir, "node_modules", "hue-sync", "signify.pem"));
  return candidates.find((candidate) => exists(candidate)) || "";
};
