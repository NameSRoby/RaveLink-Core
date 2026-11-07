/** Bound file-serving mock servers too. Each harness owns its own limiter so
 * independent apps cannot consume one another's request budget. */
const { rateLimit } = require("express-rate-limit");
module.exports = function fixtureHttpLimit({ limit = 300 } = {}) {
  return rateLimit({
    windowMs: 60000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { ok: false, error: "fixture_http_rate_limited" },
  });
};
