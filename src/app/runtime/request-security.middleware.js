// [TITLE] Module: app/runtime/request-security.middleware.js
// [TITLE] Purpose: centralized request security + parser middleware for bridge HTTP runtime
// [TITLE] Functionality Index:
// [TITLE] - origin-aware CORS/preflight handling tuned for localhost bridge usage
// [TITLE] - baseline response security headers and CSP segmentation for mod UI assets
// [TITLE] - route-aware JSON parser sizing (/mods/import large payload support)

const net = require("node:net");
const { parseBoolean } = require("../../shared/validation/parse-boolean");

const LOOPBACK_HOST_ALIASES = new Set(["127.0.0.1", "localhost", "::1"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeAddressToken(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) return raw.slice("::ffff:".length);
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
}

function isLoopbackAddressToken(value = "") {
  const token = normalizeAddressToken(value);
  if (!token) return false;
  if (LOOPBACK_HOST_ALIASES.has(token)) return true;
  if (token === "::1") return true;
  if (token.startsWith("127.")) return true;
  return false;
}

function splitHostPort(rawHostHeader = "") {
  const raw = String(rawHostHeader || "").trim();
  if (!raw) return { host: "", port: 0 };
  if (raw.startsWith("[")) {
    const match = raw.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!match) return { host: "", port: 0 };
    const host = normalizeAddressToken(match[1] || "");
    const parsedPort = Number(match[2] || 0);
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 0;
    return { host, port };
  }
  const parts = raw.split(":");
  if (parts.length === 1) {
    return { host: normalizeAddressToken(raw), port: 0 };
  }
  const maybePort = Number(parts[parts.length - 1] || 0);
  if (Number.isInteger(maybePort) && maybePort > 0 && maybePort <= 65535) {
    return {
      host: normalizeAddressToken(parts.slice(0, -1).join(":")),
      port: maybePort
    };
  }
  return { host: normalizeAddressToken(raw), port: 0 };
}

function normalizeOriginPort(parsedOrigin) {
  const explicit = Number(parsedOrigin?.port || 0);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 65535) return explicit;
  return String(parsedOrigin?.protocol || "").toLowerCase() === "https:" ? 443 : 80;
}

function isLocalOrSameHostRequest(req = {}) {
  const requestIp = normalizeAddressToken(req?.ip || "");
  const socketRemoteAddress = normalizeAddressToken(req?.socket?.remoteAddress || "");
  const socketLocalAddress = normalizeAddressToken(req?.socket?.localAddress || "");
  if (isLoopbackAddressToken(requestIp) || isLoopbackAddressToken(socketRemoteAddress)) {
    return true;
  }
  if (!socketRemoteAddress || !socketLocalAddress) return false;
  if (isLoopbackAddressToken(socketRemoteAddress) && isLoopbackAddressToken(socketLocalAddress)) {
    return true;
  }
  if (net.isIP(socketRemoteAddress) > 0 && socketRemoteAddress === socketLocalAddress) {
    return true;
  }
  return false;
}

function validateBrowserOrigin(req = {}, options = {}) {
  const allowRemoteWrite = options.allowRemoteWrite === true;
  const allowedOrigins = new Set((options.allowedOrigins || []).map(value => String(value || "").trim()).filter(Boolean));
  const origin = String(req?.headers?.origin || "").trim();
  const localRequest = isLocalOrSameHostRequest(req);
  if (!origin) {
    return {
      ok: localRequest || allowRemoteWrite,
      allowOrigin: "",
      reason: localRequest || allowRemoteWrite ? "" : "remote request without origin blocked"
    };
  }
  if (origin === "null") {
    return {
      ok: localRequest || allowRemoteWrite,
      allowOrigin: localRequest || allowRemoteWrite ? "null" : "",
      reason: "null origin blocked for non-local requests"
    };
  }

  let parsedOrigin = null;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return {
      ok: false,
      allowOrigin: "",
      reason: "invalid origin header"
    };
  }

  const protocol = String(parsedOrigin.protocol || "").toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      ok: false,
      allowOrigin: "",
      reason: "origin protocol not allowed"
    };
  }

  const requestHost = splitHostPort(req?.headers?.host || "");
  const originHost = normalizeAddressToken(parsedOrigin.hostname || "");
  const originPort = normalizeOriginPort(parsedOrigin);
  const requestPort = requestHost.port || Number(options.port || 0) || 0;
  const sameHost = Boolean(
    requestHost.host &&
    originHost &&
    requestHost.host === originHost &&
    requestPort > 0 &&
    requestPort === originPort
  );
  const loopbackAliasMatch = Boolean(
    isLoopbackAddressToken(requestHost.host) &&
    isLoopbackAddressToken(originHost) &&
    requestPort > 0 &&
    requestPort === originPort
  );
  if (sameHost || loopbackAliasMatch) {
    return {
      ok: true,
      allowOrigin: origin,
      reason: ""
    };
  }
  if ((localRequest && allowedOrigins.has(origin)) || allowRemoteWrite) {
    return {
      ok: true,
      allowOrigin: origin,
      reason: ""
    };
  }
  return {
    ok: false,
    allowOrigin: "",
    reason: "cross-origin request blocked"
  };
}

function installRequestSecurityMiddleware(app, options = {}) {
  if (!app || typeof app.use !== "function") {
    throw new Error("installRequestSecurityMiddleware requires express app");
  }
  const express = options.express;
  if (!express || typeof express.json !== "function") {
    throw new Error("installRequestSecurityMiddleware requires express module");
  }
  const allowRemoteWrite = parseBoolean(options.allowRemoteWrite, false);
  const enableLargeModImports = options.enableLargeModImports === true;
  const jsonParserDefault = express.json({ limit: "64kb", strict: true });
  const jsonParserLarge = express.json({ limit: "22mb", strict: true });
  const urlencodedParser = express.urlencoded({ extended: true });
  const port = Number(options.port || process.env.PORT || 5050);
  const allowWidgetCrossOrigin = options.allowWidgetCrossOrigin === true;
  const isWidgetCrossOriginEnabled = typeof options.isWidgetCrossOriginEnabled === "function"
    ? options.isWidgetCrossOriginEnabled
    : () => allowWidgetCrossOrigin;
  const widgetOrigins = Array.isArray(options.widgetOrigins) && options.widgetOrigins.length
    ? options.widgetOrigins
    : ["https://streamelements.com"];

  app.use((req, res, next) => {
    const requestPath = String(req.path || "");
    const isModUiRequest = requestPath.startsWith("/mods-ui/");
    let widgetCrossOriginEnabled = false;
    try { widgetCrossOriginEnabled = isWidgetCrossOriginEnabled() === true; } catch {}
    const originValidation = validateBrowserOrigin(req, {
      allowRemoteWrite,
      port,
      allowedOrigins: widgetCrossOriginEnabled && requestPath === "/widget/events" ? widgetOrigins : []
    });
    const privateNetworkRequested = String(
      req?.headers?.["access-control-request-private-network"] || ""
    ).trim().toLowerCase() === "true";
    if (originValidation.allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", originValidation.allowOrigin);
      res.setHeader("Vary", "Origin");
    }
    if (privateNetworkRequested && originValidation.ok) {
      // [DEV] Chromium private-network preflights (https origin -> localhost)
      // [DEV] require explicit opt-in to permit bridge POST routes from widgets.
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PUT,PATCH,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Requested-With, X-Ravelink-Mod-Key, X-Mod-Key, X-Api-Key, Authorization"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (isModUiRequest) {
      // External origins are capability permissions, not a default mod privilege.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-src 'self'; " +
        "media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
      );
    } else {
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
      );
    }

    if (req.method === "OPTIONS") {
      if (!originValidation.ok && !allowRemoteWrite) {
        res.status(403).json({
          ok: false,
          error: "untrusted_origin",
          detail: originValidation.reason
        });
        return;
      }
      res.sendStatus(204);
      return;
    }

    if (
      MUTATING_METHODS.has(String(req.method || "").trim().toUpperCase()) &&
      !originValidation.ok &&
      !allowRemoteWrite
    ) {
      res.status(403).json({
        ok: false,
        error: "untrusted_origin",
        detail: originValidation.reason
      });
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    const parser = enableLargeModImports && String(req.path || "") === "/mods/import"
      ? jsonParserLarge
      : jsonParserDefault;
    parser(req, res, next);
  });

  app.use(urlencodedParser);

  app.use((err, req, res, next) => {
    if (!err) {
      next();
      return;
    }
    if (err.type === "entity.too.large") {
      res.status(413).json({
        ok: false,
        error: "payload too large"
      });
      return;
    }
    if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, "body")) {
      res.status(400).json({
        ok: false,
        error: "invalid json payload"
      });
      return;
    }
    next(err);
  });
}

module.exports = {
  installRequestSecurityMiddleware,
  validateBrowserOrigin,
  isLocalOrSameHostRequest
};
