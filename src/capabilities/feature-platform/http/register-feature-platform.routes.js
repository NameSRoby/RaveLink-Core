/**
 * Feature HTTP and sandbox policy.
 * The parent shell brokers only the current page's declared capabilities; worker
 * contracts and host authorization still apply behind it. feature-ui-relay.js is
 * serialized browser code so it can be reviewed independently of the HTML template.
 * Keep scriptJson escaping: an interpolated closing script tag must remain data.
 */
const featureUiRelay = require("./feature-ui-relay");
const featureDraftScript = require("./feature-draft-script");
const featurePresentation = require("./feature-presentation");
const featureThemeScript = require("./feature-theme-script");
const { isLocalOrSameHostRequest } = require("../../../app/runtime/request-security.middleware");

const FEATURE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const PAGE_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

function htmlText(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function allowsExternalPopup(featureId, pageId) {
  return (
    (featureId === "twitch-integration" && pageId === "connection") ||
    (featureId === "song-request" && ["player", "server-playlist"].includes(pageId))
  );
}

function featurePageShell(featureId, page, pageIds) {
  const config = scriptJson({
    featureId,
    pageId: page.id,
    surface: page.surface,
    capabilities: page.capabilities,
    pageIds,
  });
  const popupSandbox = allowsExternalPopup(featureId, page.id)
    ? " allow-popups allow-popups-to-escape-sandbox"
    : "";
  const embedSandbox = page.embedHosts.length ? " allow-same-origin" : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlText(page.title)}</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:${page.surface === "overlay" ? "transparent" : "#050507"}}iframe{display:block}body{overflow:hidden}</style></head><body><iframe id="surface" ${featureId === "song-request" && page.id === "player" ? 'allow="autoplay"' : ""} data-src="/features-content/${featureId}/${page.id}" sandbox="allow-scripts allow-presentation${featureId === "song-request" && page.id === "server-playlist" ? " allow-downloads" : ""}${embedSandbox}${popupSandbox}"  referrerpolicy="no-referrer" title="${htmlText(page.title)}"></iframe><script src="/action-feedback.js"></script><script src="/feature-events-client.js"></script><script>${featureDraftScript(featureId, page.id, page.surface)}${featureThemeScript(featureId, page.id)}(${featureUiRelay.toString()})(${config});</script></body></html>`;
}

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

module.exports = function registerFeaturePlatformRoutes(app, options = {}) {
  const registry = options.registry;
  app.get("/api/features", requireLocalOperator, (req, res) => res.json(registry.list()));
  app.get("/api/features-stream", requireLocalOperator, (req, res) => {
    let unsubscribe;
    const send = (type, value) => {
      if (type === "close") {
        res.end();
        return;
      }
      if (!res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)) {
        unsubscribe?.();
        res.destroy();
      }
    };
    unsubscribe = registry.subscribeStream(send);
    if (!unsubscribe) return res.status(503).json({ ok: false, error: "feature_stream_limit" });
    res.on("close", unsubscribe);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    send("lifecycle", registry.list());
  });
  app.get("/api/features-lifecycle", requireLocalOperator, (req, res) => {
    let unsubscribe;
    const send = (snapshot) => {
      if (!snapshot) {
        res.end();
        return;
      }
      if (!res.write(`event: lifecycle\ndata: ${JSON.stringify(snapshot)}\n\n`)) {
        unsubscribe?.();
        res.destroy();
      }
    };
    unsubscribe = registry.subscribeLifecycle(send);
    if (!unsubscribe) return res.status(503).json({ ok: false, error: "feature_listener_limit" });
    res.on("close", unsubscribe);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    send(registry.list());
  });
  app.get("/api/features-available", requireLocalOperator, async (req, res) =>
    res.json(await registry.listAvailable()),
  );
  app.post("/api/features/:featureId/install", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.install(featureId);
    return res
      .status(result.ok ? 201 : result.error === "feature_already_installed" ? 409 : 400)
      .json(result);
  });
  app.post("/api/features/:featureId/enable", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.enable(featureId);
    return res
      .status(result.ok === false ? 400 : result.lifecycle === "active" ? 200 : 409)
      .json(result);
  });
  app.post("/api/features/:featureId/disable", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.disable(featureId);
    return res.status(result.ok === false ? 400 : 200).json(result);
  });
  app.post("/api/features/:featureId/restart", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.restart(featureId);
    return res
      .status(
        result.lifecycle === "active" ? 200 : result.error === "feature_not_found" ? 404 : 409,
      )
      .json(result);
  });
  app.post("/api/features/:featureId/update", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.update(featureId);
    return res
      .status(
        result.ok
          ? 200
          : result.error === "feature_not_found"
            ? 404
            : result.error === "feature_update_not_available"
              ? 409
              : 400,
      )
      .json(result);
  });
  app.post("/api/features/:featureId/rollback", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.rollback(featureId);
    return res
      .status(
        result.ok
          ? 200
          : result.error === "feature_not_found" || result.error === "feature_rollback_unavailable"
            ? 404
            : 400,
      )
      .json(result);
  });
  app.delete("/api/features/:featureId", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.uninstall(featureId, {
      deleteData: req.query?.deleteData === "true",
    });
    return res
      .status(result.ok ? 200 : result.error === "feature_not_found" ? 404 : 400)
      .json(result);
  });
  app.get("/api/features/:featureId/events", requireLocalOperator, (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    if (!registry.list().features.some((row) => row.id === featureId))
      return res.status(404).json({ ok: false, error: "feature_not_found" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("event: ready\ndata: {}\n\n");
    const unsubscribe = registry.subscribe(featureId, (message) => {
      res.write(`event: feature\ndata: ${JSON.stringify(message)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 25000);
    keepAlive.unref?.();
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return undefined;
  });
  app.post("/api/features/:featureId/call", requireLocalOperator, async (req, res) => {
    const featureId = String(req.params.featureId || "");
    if (!FEATURE_ID_RE.test(featureId))
      return res.status(400).json({ ok: false, error: "invalid_feature_id" });
    const result = await registry.request(
      featureId,
      req.body?.capability,
      req.body?.method,
      req.body?.payload,
      { timeoutMs: req.body?.timeoutMs },
    );
    res.status(result.ok ? 200 : result.error?.retryable ? 503 : 400).json(result);
  });
  app.get("/features-ui/:featureId/:pageId", requireLocalOperator, async (req, res, next) => {
    try {
      const featureId = String(req.params.featureId || "");
      const pageId = String(req.params.pageId || "");
      if (!FEATURE_ID_RE.test(featureId) || !PAGE_ID_RE.test(pageId))
        return res.status(400).type("text/plain").send("invalid_feature_page");
      const result = await registry.readUiContribution(featureId, pageId);
      if (!result.ok)
        return res
          .status(
            result.error === "ui_contribution_not_found" || result.error === "feature_not_found"
              ? 404
              : 403,
          )
          .type("text/plain")
          .send(result.error);
      const feature = registry.list().features.find((row) => row.id === featureId);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.type("html").send(
        featurePageShell(
          featureId,
          result.page,
          (feature?.uiContributions || []).map((page) => page.id),
        ),
      );
    } catch (error) {
      return next(error);
    }
  });
  app.get("/features-content/:featureId/:pageId", requireLocalOperator, async (req, res, next) => {
    try {
      const featureId = String(req.params.featureId || "");
      const pageId = String(req.params.pageId || "");
      if (!FEATURE_ID_RE.test(featureId) || !PAGE_ID_RE.test(pageId))
        return res.status(400).type("text/plain").send("invalid_feature_page");
      const result = await registry.readUiContribution(featureId, pageId);
      if (!result.ok)
        return res
          .status(
            result.error === "ui_contribution_not_found" || result.error === "feature_not_found"
              ? 404
              : 403,
          )
          .type("text/plain")
          .send(result.error);
      const external = result.page.embedHosts.map((host) => `https://${host}`);
      const images = result.page.imageHosts.map((host) => `https://${host}`);
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'none'",
          `script-src 'unsafe-inline' ${external.join(" ")}`.trim(),
          "style-src 'unsafe-inline'",
          `frame-src ${external.length ? external.join(" ") : "'none'"}`,
          `img-src data: ${images.join(" ")}`.trim(),
          "connect-src 'none'",
          "media-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'self'",
          `sandbox allow-scripts allow-presentation${featureId === "song-request" && pageId === "server-playlist" ? " allow-downloads" : ""}${result.page.embedHosts.length ? " allow-same-origin" : ""}${allowsExternalPopup(featureId, pageId) ? " allow-popups allow-popups-to-escape-sandbox" : ""}`,
        ].join("; "),
      );
      res.setHeader("Cache-Control", "no-store");
      // YouTube rejects IFrame API playback without client identification (error 153).
      // External feature players receive only the loopback origin, never a path or token.
      res.setHeader("Referrer-Policy", result.page.embedHosts.length ? "origin" : "no-referrer");
      return res
        .type("html")
        .send(
          result.page.surface === "panel" ? featurePresentation(result.content) : result.content,
        );
    } catch (error) {
      return next(error);
    }
  });
  return Object.freeze({ prefix: "/api/features" });
};

module.exports.requireLocalOperator = requireLocalOperator;
