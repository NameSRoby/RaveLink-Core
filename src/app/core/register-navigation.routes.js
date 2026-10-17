/**
 * Register navigation routes.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
const fs = require("node:fs");
const path = require("node:path");
const { rateLimit } = require("express-rate-limit");
const {
  isLocalOrSameHostRequest,
  validateBrowserOrigin,
} = require("../runtime/request-security.middleware");
const defaults = {
  lights: "main",
  fixtures: "main",
  widget: "main",
  updates: "more",
  features: "more",
  mods: "more",
  "feature:song-request": "main",
  "feature:twitch-integration": "main",
};
module.exports = function registerNavigationRoutes(app, { runtimeDir, rateLimitOptions = {} }) {
  const file = path.join(runtimeDir, "system", "navigation.json");
  let tabs = { ...defaults },
    configured = false;
  const valid = (value) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([id, mode]) =>
        (Object.hasOwn(defaults, id) || /^feature:[a-z][a-z0-9-]{1,60}$/.test(id)) &&
        ["main", "more", "hidden"].includes(mode),
    );
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (valid(saved.tabs)) {
      tabs = { ...defaults, ...saved.tabs };
      configured = true;
    }
  } catch {}
  const local = (req, res, next) =>
    isLocalOrSameHostRequest(req) && validateBrowserOrigin(req).ok
      ? next()
      : res.status(403).json({ ok: false, error: "navigation_loopback_required" });
  const snapshot = () => ({ ok: true, configured, tabs });
  app.get("/api/presentation/navigation", local, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot());
  });
  const saveLimit = rateLimit({
    windowMs: 60000,
    limit: 30,
    keyGenerator: () => "navigation",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...rateLimitOptions,
    message: { ok: false, error: "navigation_rate_limited" },
  });
  app.put("/api/presentation/navigation", local, saveLimit, (req, res) => {
    if (!valid(req.body?.tabs))
      return res.status(400).json({ ok: false, error: "navigation_invalid" });
    const next = { ...defaults, ...req.body.tabs };
    if (
      configured &&
      Object.keys(next).length === Object.keys(tabs).length &&
      Object.entries(next).every(([id, mode]) => tabs[id] === mode)
    )
      return res.json(snapshot());
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify({ version: 1, tabs: next }) + "\n");
      fs.renameSync(file + ".tmp", file);
      tabs = next;
      configured = true;
    } catch {
      return res.status(503).json({ ok: false, error: "navigation_save_failed" });
    }
    res.json(snapshot());
  });
};
