// [TITLE] Module: domains/system/widget-intake-token.js
// [TITLE] Purpose: scoped widget intake token parsing and verification helpers

const crypto = require("node:crypto");

function asString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeWidgetIntakeToken(value = "") {
  return asString(value).slice(0, 512);
}

function getByPath(source, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (!current || typeof current !== "object") return "";
    current = current[part];
  }
  return current;
}

function extractBearerToken(headerValue = "") {
  const value = asString(headerValue);
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? normalizeWidgetIntakeToken(match[1]) : "";
}

function readWidgetIntakeTokenFromRequest(req = {}, body = {}) {
  const headers = req.headers && typeof req.headers === "object" ? req.headers : {};
  return normalizeWidgetIntakeToken(
    extractBearerToken(headers.authorization || headers.Authorization) ||
    headers["x-ravelink-widget-token"] ||
    headers["x-widget-token"] ||
    getByPath(body, "widgetIntakeToken") ||
    getByPath(body, "widgetConfig.widgetIntakeToken")
  );
}

function timingSafeTokenEqual(left = "", right = "") {
  const a = Buffer.from(normalizeWidgetIntakeToken(left));
  const b = Buffer.from(normalizeWidgetIntakeToken(right));
  if (!a.length || !b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  normalizeWidgetIntakeToken,
  readWidgetIntakeTokenFromRequest,
  timingSafeTokenEqual
};
