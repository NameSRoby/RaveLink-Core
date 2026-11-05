const { requireLocalOperator } = require("../runtime/local-operator.middleware");
const { rateLimit } = require("express-rate-limit");
module.exports = function registerNetworkSharing(app, service) {
  app.get("/api/network-sharing", requireLocalOperator, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(service.snapshot());
  });
  const limit = rateLimit({
    windowMs: 60000,
    limit: 12,
    keyGenerator: () => "network-sharing",
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.put("/api/network-sharing", requireLocalOperator, limit, async (req, res) => {
    try {
      res.json(await service.configure(req.body, req.socket.localPort));
    } catch (error) {
      res
        .status(error.code === "network_sharing_invalid" ? 400 : 409)
        .json({ ok: false, error: error.code || "network_sharing_failed" });
    }
  });
};
