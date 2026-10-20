/** Trusted operator surface, deliberately outside contributed-code sandboxes.
 * Only Core-owned HTML/JS runs here. A null-origin contribution cannot grant
 * capture/output or change source/fixture bindings through these routes.
 */
const { rateLimit } = require("express-rate-limit");
const {
  requireLocalOperator,
} = require("../../capabilities/feature-platform/http/register-feature-platform.routes");
module.exports = function registerMusicToLightRoutes(app, { host }) {
  const limit = rateLimit({
    windowMs: 60000,
    limit: 60,
    keyGenerator: () => "music-operator",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { ok: false, error: "music_operator_rate_limited" },
  });
  const calls = rateLimit({
    windowMs: 60000,
    limit: 300,
    keyGenerator: () => "music-client",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => req.body?.capability === "music.session.v1" && req.body?.method === "stop",
    message: { ok: false, error: "music_call_rate_limited" },
  });
  app.use("/api/music-to-light", requireLocalOperator, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/music-to-light/operator", (req, res) => res.json({ ok: true, value: host.view() }));
  app.get("/api/music-to-light/pipeline", (req, res) =>
    res.json({ ok: true, value: host.pipeline() }),
  );
  app.get("/api/music-to-light/catalog", (req, res) =>
    res.json({
      ok: true,
      value: {
        revision: 15,
        recipeAxes: require("../../../integrations/music-to-light/recipe.cjs").axes,
        looks: require("../../../integrations/music-to-light/looks.cjs"),
        behaviors: require("../../../integrations/music-to-light/behavior-settings.cjs").catalog,
        scenarios: require("../../../integrations/music-to-light/scenarios.cjs").definitions,
        baseline: require("../../../integrations/music-to-light/profiles/accepted-baseline-v1.json"),
      },
    }),
  );
  app.get("/api/music-to-light/effects", (req, res) =>
    res.json({ ok: true, value: host.effects() }),
  );
  for (const [route, method] of [
    ["effects/save", "saveEffect"],
    ["effects/policy", "effectPolicy"],
    ["effects/delete", "deleteEffect"],
  ]) {
    app.post("/api/music-to-light/" + route, limit, (req, res) => {
      try {
        res.json({
          ok: true,
          value: host[method](route.endsWith("delete") ? req.body?.id : req.body),
        });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: /^[a-z_]{1,80}$/.test(error.code || "")
            ? error.code
            : "music_effect_request_failed",
        });
      }
    });
  }
  app.post("/api/music-to-light/call", calls, async (req, res) => {
    try {
      res.json({ ok: true, value: await host.call(req.body) });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: /^[a-z_]{1,80}$/.test(error.code || "") ? error.code : "music_request_failed",
      });
    }
  });
  for (const [route, method] of [
    ["permissions", "permissions"],
    ["source", "source"],
    ["sources", "sources"],
    ["fixtures", "fixtures"],
  ]) {
    app.put("/api/music-to-light/" + route, limit, async (req, res) => {
      try {
        const body = req.body;
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, "value"))
          throw Error("invalid_music_request");
        await host[method](body.value);
        res.json({ ok: true, value: host.view() });
      } catch (error) {
        const code = /^[a-z_]{1,80}$/.test(error.code || error.message || "")
          ? error.code || error.message
          : "music_operator_failed";
        res.status(400).json({ ok: false, error: code });
      }
    });
  }
};
