/** Shared operator admission; importing it never loads an optional platform. */
const { isLocalOrSameHostRequest } = require("./request-security.middleware");

function requireLocalOperator(req, res, next) {
  if (!isLocalOrSameHostRequest(req))
    return res.status(403).json({ ok: false, error: "feature_operator_loopback_required" });
  const origin = String(req.headers?.origin || "").trim();
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers?.host || "").toLowerCase())
        throw new Error("origin_mismatch");
    } catch {
      return res.status(403).json({ ok: false, error: "feature_operator_same_origin_required" });
    }
  }
  return next();
}

module.exports = { requireLocalOperator };
