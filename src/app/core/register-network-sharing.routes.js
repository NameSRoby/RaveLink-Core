const { requireLocalOperator } = require("../runtime/local-operator.middleware");
const { rateLimit } = require("express-rate-limit");
module.exports = function registerNetworkSharing(app, service, firewall) {
  app.get("/api/network-sharing", requireLocalOperator, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(service.snapshot());
  });
  app.get("/api/network-sharing/qr.svg", requireLocalOperator, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const state = service.snapshot();
    if (!state.active || typeof req.query.url !== "string" || !state.urls.includes(req.query.url))
      return res.status(400).json({ ok: false, error: "network_sharing_address_unavailable" });
    try {
      const svg = await require("qrcode").toString(req.query.url, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 4,
        width: 240,
        color: { dark: "#000000", light: "#ffffff" },
      });
      res.type("image/svg+xml").send(svg);
    } catch {
      res.status(500).json({ ok: false, error: "network_sharing_qr_failed" });
    }
  });
  const limit = rateLimit({
    windowMs: 60000,
    limit: 12,
    keyGenerator: () => "network-sharing",
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.post("/api/network-sharing/firewall", requireLocalOperator, limit, async (req, res) => {
    // LAN proxy requests retain their private-IP Host header and cannot trigger elevation.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || ""))
      return res.status(403).json({ ok: false, error: "firewall_setup_local_pc_required" });
    if (!firewall) return res.status(503).json({ ok: false, error: "firewall_setup_unavailable" });
    try {
      res.json(await firewall.configure());
    } catch (error) {
      res.status(409).json({ ok: false, error: error.code || "firewall_setup_failed" });
    }
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
