/** Local dashboard preferences contain identifiers and presentation choices only. */
const fs = require("node:fs");
const path = require("node:path");
const { rateLimit } = require("express-rate-limit");
const { requireLocalOperator } = require("../runtime/local-operator.middleware");
const catalog = require("../../domains/system/dashboard-catalog.json");
const widgetIds = new Set(catalog.map((row) => row.id));
const actionIds = new Set(catalog.flatMap((row) => row.actions.map((action) => action.id)));
const defaults = () => ({
  widgets: catalog.filter((row) => row.default).map((row) => row.id),
  hiddenActions: [],
  density: "comfortable",
  columns: "auto",
});
function valid(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    ["comfortable", "compact"].includes(value.density) &&
    ["auto", "one", "two"].includes(value.columns) &&
    [
      [value.widgets, widgetIds],
      [value.hiddenActions, actionIds],
    ].every(
      ([items, allowed]) =>
        Array.isArray(items) &&
        items.length <= allowed.size &&
        new Set(items).size === items.length &&
        items.every((id) => allowed.has(id)),
    )
  );
}
module.exports = function registerDashboardLayout(app, { runtimeDir }) {
  const file = path.join(runtimeDir, "system", "dashboard.json");
  let layout = defaults();
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (valid(stored.layout)) layout = stored.layout;
  } catch {
    /* New or invalid state uses the defaults. */
  }
  const snapshot = () => ({ ok: true, layout, catalog });
  app.get("/api/presentation/dashboard", requireLocalOperator, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot());
  });
  app.put(
    "/api/presentation/dashboard",
    requireLocalOperator,
    rateLimit({ windowMs: 60000, limit: 30, keyGenerator: () => "dashboard-layout" }),
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!req.body || Object.keys(req.body).length !== 1 || !valid(req.body.layout))
        return res.status(400).json({ ok: false, error: "dashboard_layout_invalid" });
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file + ".tmp",
          JSON.stringify({ version: 1, layout: req.body.layout }) + "\n",
        );
        fs.renameSync(file + ".tmp", file);
        layout = req.body.layout;
        res.json(snapshot());
      } catch {
        res.status(503).json({ ok: false, error: "dashboard_layout_save_failed" });
      }
    },
  );
};
