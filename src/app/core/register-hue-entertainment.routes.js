/** Local operator configuration only; discovering areas never starts a stream. */
const { rateLimit } = require("express-rate-limit");
const { requireLocalOperator } = require("../runtime/local-operator.middleware");
module.exports = function registerHueEntertainmentRoutes(app, core) {
  const service = require("../../domains/fixtures/hue-entertainment-config.service")({
    registry: core.fixtureRegistry,
    bridge: core.hueBridge,
    isInUse: (id) =>
      core.fixtureOutput?.ownership.snapshot().fixtures.some((f) => f.fixtureId === id),
  });
  const limit = rateLimit({ windowMs: 60000, limit: 60, keyGenerator: () => "hue-area-config" });
  for (const method of ["get", "put"]) {
    app[method](
      "/fixtures/:id/hue-entertainment",
      requireLocalOperator,
      limit,
      async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
          const result =
            method === "get"
              ? await service.discover(req.params.id)
              : await service.save(req.params.id, req.body);
          res.json(result);
        } catch (error) {
          const code = /^[a-z_]{1,80}$/.test(error.code || "")
            ? error.code
            : "hue_entertainment_config_failed";
          res.status(code === "fixture_not_found" ? 404 : 400).json({ ok: false, error: code });
        }
      },
    );
  }
};
