// [TITLE] Module: capabilities/mod-platform/http/register-mod-platform.routes.js
// [TITLE] Purpose: loopback-only operator API for the optional mod host

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isLocalOrSameHostRequest } = require("../../../app/runtime/request-security.middleware");

const MOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;
const CANDIDATE_ID_RE = /^[a-f0-9]{24}$/;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

function requireLoopback(req, res, next) {
  if (!isLocalOrSameHostRequest(req)) {
    return res.status(403).json({ ok: false, error: "mod_admin_loopback_required" });
  }
  const origin = String(req.headers?.origin || "").trim();
  if (origin) {
    let originHost = "";
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") originHost = parsed.host.toLowerCase();
    } catch {}
    const requestHost = String(req.headers?.host || "").trim().toLowerCase();
    if (!originHost || !requestHost || originHost !== requestHost) {
      return res.status(403).json({ ok: false, error: "mod_admin_same_origin_required" });
    }
  }
  return next();
}

function validModId(req, res, next) {
  const modId = String(req.params?.modId || "");
  if (!MOD_ID_RE.test(modId)) return res.status(400).json({ ok: false, error: "invalid_mod_id" });
  req.modId = modId;
  return next();
}

function resultStatus(result) {
  if (result?.ok !== false) return 200;
  if (["mod_not_found", "rollback_unavailable"].includes(result.error)) return 404;
  if (["active_mod_limit", "mod_must_be_disabled", "permission_approval_required"].includes(result.error)) return 409;
  return 400;
}

module.exports = function registerModPlatformRoutes(app, options = {}) {
  const express = options.express;
  const registry = options.registry;
  const packageManager = options.packageManager;
  const inbox = options.inbox || null;
  const uploadRoot = path.resolve(String(options.uploadRoot || path.join(process.cwd(), "runtime", "mods", "uploads")));
  if (!app || !express || !registry || !packageManager) {
    throw new Error("registerModPlatformRoutes requires app, express, registry, and packageManager");
  }

  async function snapshot() {
    await inbox?.ready?.();
    const host = registry.list();
    const mods = await Promise.all(host.mods.map(async row => {
      if (!row.valid) return row;
      const installed = await packageManager.getInstalledStatus(row.id);
      return installed.ok ? { ...row, approval: installed.approval, rollbackAvailable: installed.rollbackAvailable, dataPresent: installed.dataPresent } : row;
    }));
    const installed = new Map(mods.map(row => [row.id, row]));
    const inboxSnapshot = inbox?.list?.() || { ok: true, inbox: "mod", total: 0, candidates: [] };
    const candidates = inboxSnapshot.candidates.map(row => ({
      ...row,
      installed: installed.get(row.id)?.version === row.version
        && installed.get(row.id)?.approval?.fingerprint === row.fingerprint,
      active: installed.get(row.id)?.enabled === true
    }));
    return { ...host, mods, resources: registry.getResourceStatus(), inbox: { ...inboxSnapshot, candidates } };
  }

  app.get("/api/mod-platform", requireLoopback, async (_req, res, next) => {
    try { res.json(await snapshot()); } catch (error) { next(error); }
  });
  app.post("/api/mod-platform/discover", requireLoopback, async (_req, res, next) => {
    try { await inbox?.scan?.(); registry.discover(); res.json(await snapshot()); } catch (error) { next(error); }
  });
  app.get("/api/mod-platform/events", requireLoopback, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("event: ready\ndata: {}\n\n");
    const unsubscribe = inbox?.subscribe?.(() => res.write("event: inbox\ndata: {}\n\n")) || (() => {});
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 25000);
    keepAlive.unref?.();
    req.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
  });
  app.post("/api/mod-platform/inbox/:candidateId/accept", requireLoopback, async (req, res, next) => {
    try {
      const id = String(req.params?.candidateId || "");
      if (!CANDIDATE_ID_RE.test(id) || !inbox) return res.status(400).json({ ok: false, error: "invalid_inbox_candidate" });
      await inbox.scan();
      const candidate = inbox.resolve(id);
      if (!candidate) return res.status(404).json({ ok: false, error: "inbox_candidate_not_found" });
      if (!candidate.valid) return res.status(400).json({ ok: false, error: candidate.error || "package_invalid" });
      const expected = String(req.body?.fingerprint || "");
      if (!expected || expected !== candidate.approval?.fingerprint) {
        return res.status(409).json({ ok: false, error: "inbox_candidate_changed" });
      }
      const replace = req.body?.replace === true;
      const installed = candidate.kind === "archive"
        ? await packageManager.installArchive(candidate.sourcePath, { replace })
        : await packageManager.install(candidate.sourcePath, { replace });
      if (!installed.ok) return res.status(resultStatus(installed)).json(installed);
      const approval = await packageManager.approve(installed.modId, expected);
      if (!approval.ok) return res.status(resultStatus(approval)).json(approval);
      registry.discover();
      const activation = await registry.enable(installed.modId, { allowUnsafeRuntime: req.body?.allowUnsafeRuntime === true });
      const ok = activation?.ok !== false && activation?.lifecycle === "active";
      return res.status(ok ? 200 : 409).json({
        ok,
        error: ok ? undefined : (activation?.error || activation?.lifecycle || "mod_activation_failed"),
        operation: "accepted",
        modId: installed.modId,
        installed,
        approval,
        activation,
        host: await snapshot()
      });
    } catch (error) { return next(error); }
  });
  app.get("/mods-ui/:modId/:panelId", requireLoopback, validModId, async (req, res, next) => {
    try {
      const result = await registry.readUiContribution(req.modId, req.params.panelId);
      if (!result.ok) return res.status(result.error === "ui_contribution_not_found" ? 404 : 403).type("text/plain").send(result.error);
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
      res.setHeader("Cache-Control", "no-store");
      return res.type("html").send(result.content);
    } catch (error) { return next(error); }
  });
  app.post(
    "/api/mod-platform/packages",
    requireLoopback,
    express.raw({ type: ["application/zip", "application/octet-stream"], limit: MAX_UPLOAD_BYTES }),
    async (req, res, next) => {
      let uploadPath = "";
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length < 4) {
          return res.status(400).json({ ok: false, error: "zip_body_required" });
        }
        await fs.promises.mkdir(uploadRoot, { recursive: true });
        uploadPath = path.join(uploadRoot, `${process.pid}-${crypto.randomBytes(12).toString("hex")}.zip`);
        await fs.promises.writeFile(uploadPath, req.body, { flag: "wx", mode: 0o600 });
        const result = await packageManager.installArchive(uploadPath, { replace: req.query?.replace === "1" });
        registry.discover();
        return res.status(resultStatus(result)).json({ ...result, host: await snapshot() });
      } catch (error) {
        return next(error);
      } finally {
        if (uploadPath) await fs.promises.rm(uploadPath, { force: true }).catch(() => {});
      }
    }
  );

  app.post("/api/mod-platform/:modId/approve", requireLoopback, validModId, async (req, res, next) => {
    try {
      const result = await packageManager.approve(req.modId, String(req.body?.fingerprint || ""));
      res.status(resultStatus(result)).json(result);
    } catch (error) { next(error); }
  });
  app.post("/api/mod-platform/:modId/enable", requireLoopback, validModId, async (req, res, next) => {
    try {
      const result = await registry.enable(req.modId, { allowUnsafeRuntime: req.body?.allowUnsafeRuntime === true });
      res.status(resultStatus(result)).json(result);
    } catch (error) { next(error); }
  });
  app.post("/api/mod-platform/:modId/disable", requireLoopback, validModId, async (req, res, next) => {
    try { const result = await registry.disable(req.modId); res.status(resultStatus(result)).json(result); } catch (error) { next(error); }
  });
  app.post("/api/mod-platform/:modId/rollback", requireLoopback, validModId, async (req, res, next) => {
    try {
      const result = await packageManager.rollback(req.modId);
      registry.discover();
      res.status(resultStatus(result)).json(result);
    } catch (error) { next(error); }
  });
  app.delete("/api/mod-platform/:modId", requireLoopback, validModId, async (req, res, next) => {
    try {
      const result = await packageManager.uninstall(req.modId, { deleteData: req.body?.deleteData === true });
      registry.discover();
      res.status(resultStatus(result)).json(result);
    } catch (error) { next(error); }
  });

  return Object.freeze({ snapshot });
};

module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.requireLoopback = requireLoopback;
module.exports.resultStatus = resultStatus;
