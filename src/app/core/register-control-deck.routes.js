/** Trusted operator API; viewing or editing a deck cannot execute its actions. */
const { rateLimit } = require("express-rate-limit");
const { requireLocalOperator } = require("../runtime/local-operator.middleware");
module.exports = function registerControlDeck(
  app,
  { service, media, desktop, obs, widgets, express, getTwitchClips = () => null },
) {
  const limiter = (limit) =>
    rateLimit({
      windowMs: 60000,
      limit,
      keyGenerator: () => "control-deck",
      standardHeaders: "draft-8",
      legacyHeaders: false,
    });
  const edit = limiter(90),
    execute = limiter(180),
    mediaRead = limiter(3600),
    upload = limiter(20);
  const obsPreview = limiter(90);
  app.use("/api/control-deck", requireLocalOperator, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const route = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, value: await fn(req) });
    } catch (error) {
      const code = /^[a-z][a-z0-9_]{0,79}$/.test(error?.code || "")
        ? error.code
        : "control_deck_request_failed";
      res
        .status(/busy|conflict|unavailable/.test(code) ? 409 : 400)
        .json({ ok: false, error: code });
    }
  };
  if (widgets) {
    app.get(
      "/api/control-deck/timestamps",
      route(() => ({ items: widgets.timestamps.list(1000) })),
    );
    app.post(
      "/api/control-deck/timestamps",
      execute,
      route((req) => widgets.timestamps.create(req.body)),
    );
    app.delete(
      "/api/control-deck/timestamps/:id",
      edit,
      route((req) => widgets.timestamps.remove(req.params.id)),
    );
  }
  if (obs) {
    const local = require("../../domains/control-deck/obs-local")(obs.configure);
    app.get(
      "/api/control-deck/obs",
      route(async (req) => {
        await obs.refresh(req.query.refresh === "true");
        return { ...obs.snapshot(), local: local.status() };
      }),
    );
    app.put(
      "/api/control-deck/obs/connection",
      edit,
      route((req) => obs.configure(req.body)),
    );
    app.post(
      "/api/control-deck/obs/local",
      edit,
      route(() => local.connect()),
    );
    app.post(
      "/api/control-deck/obs/disconnect",
      edit,
      route(() => {
        const { host, port } = obs.snapshot().connection;
        return obs.configure({ host, port, enabled: false });
      }),
    );
    app.get(
      "/api/control-deck/obs/browse",
      route((req) =>
        obs.browse({
          kind: req.query.kind,
          name: req.query.name,
          group: req.query.group === "true",
        }),
      ),
    );
    app.get(
      "/api/control-deck/obs/preview",
      obsPreview,
      route(async (req) => ({ image: await obs.screenshot(req.query.scene) })),
    );
    app.post(
      "/api/control-deck/obs/buttons",
      edit,
      route(async (req) => {
        if (
          !req.body ||
          Object.keys(req.body).some((k) => !["target", "previewImage"].includes(k)) ||
          (req.body.previewImage !== undefined && typeof req.body.previewImage !== "boolean")
        )
          throw { code: "obs_target_invalid" };
        const result = await obs.add(req.body.target);
        if (req.body.previewImage && ["scene", "preview"].includes(result.target.kind)) {
          const image = await obs.screenshot(result.target.sceneName);
          result.imageId = media.store(Buffer.from(image.split(",")[1], "base64"), "image/jpeg").id;
        }
        return result;
      }),
    );
  }
  app.get(
    "/api/control-deck/state",
    route(() => {
      void service.refreshLive?.().catch(() => {});
      return JSON.parse(service.live.current());
    }),
  );
  app.get("/api/control-deck/events", (req, res) => {
    let detach, heartbeat, pending;
    const close = () => {
      clearInterval(heartbeat);
      detach?.();
    };
    const send = (frame) => {
      if (frame === null) {
        res.end();
        return;
      }
      if (res.writableNeedDrain) {
        pending = frame;
        return;
      }
      res.write("data: " + frame + "\n\n");
    };
    try {
      // Reserve the bounded slot before flushing HTTP headers.
      let ready = false;
      const initial = [];
      detach = service.live.listen((frame) => (ready ? send(frame) : initial.push(frame)));
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      ready = true;
      for (const frame of initial) send(frame);
      heartbeat = setInterval(() => {
        if (!res.writableNeedDrain) res.write(": keepalive\n\n");
      }, 15000);
      heartbeat.unref?.();
      res.on("drain", () => {
        if (pending) {
          const frame = pending;
          pending = null;
          send(frame);
        }
      });
      res.on("close", close);
      res.on("error", close);
    } catch {
      close();
      res.status(409).json({ ok: false, error: "control_deck_stream_busy" });
    }
  });
  app.get(
    "/api/control-deck",
    route(async () => {
      await service.refresh?.();
      return service.snapshot();
    }),
  );
  app.get(
    "/api/control-deck/catalog",
    route(async () => {
      await service.refresh?.();
      return service.catalog();
    }),
  );
  app.put(
    "/api/control-deck",
    edit,
    route((req) => {
      if (!req.body || Object.keys(req.body).some((k) => !["value", "revision"].includes(k)))
        throw { code: "control_deck_request_invalid" };
      return service.save(req.body.value, req.body.revision);
    }),
  );
  app.post(
    "/api/control-deck/buttons/:id/execute",
    execute,
    route((req) => {
      if (!req.body || Object.keys(req.body).some((k) => !["trigger", "value"].includes(k)))
        throw { code: "control_deck_request_invalid" };
      return service.execute(req.params.id, req.body.trigger, req.body.value);
    }),
  );
  app.post(
    "/api/control-deck/cancel",
    route((req) => {
      if (!req.body || Object.keys(req.body).some((k) => k !== "runId"))
        throw { code: "control_deck_request_invalid" };
      return service.cancel(req.body.runId);
    }),
  );
  app.post(
    "/api/control-deck/media",
    upload,
    express.raw({ type: ["image/png", "image/jpeg", "image/gif"], limit: "2mb" }),
    route((req) => media.store(req.body, req.headers["content-type"]?.split(";")[0])),
  );
  app.post(
    "/api/control-deck/screen-media",
    upload,
    express.raw({
      type: ["image/png", "image/jpeg", "image/gif", "video/mp4", "video/webm"],
      limit: "16mb",
    }),
    route((req) => media.storeScreen(req.body, req.headers["content-type"]?.split(";")[0])),
  );
  app.get("/api/control-deck/media/:id", mediaRead, (req, res) => {
    try {
      const asset = media.read(req.params.id);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.type(asset.type).sendFile(asset.file);
    } catch {
      res.status(404).json({ ok: false, error: "control_deck_media_missing" });
    }
  });
  app.get(
    "/api/control-deck/integrations",
    route(async () => ({
      ...(await desktop.integrations()),
      twitchClips: getTwitchClips()
        ? await getTwitchClips().status()
        : { available: false, code: "twitch_integration_unavailable" },
    })),
  );
  app.post(
    "/api/control-deck/integrations/discord/bind",
    edit,
    route(() => desktop.bindDiscord()),
  );
  app.get(
    "/api/control-deck/windows/audio",
    route(() => desktop.audioStatus()),
  );
  app.post(
    "/api/control-deck/windows/audio",
    execute,
    route((req) => desktop.audioApply(req.body)),
  );
  app.post(
    "/api/control-deck/windows/hotkey",
    execute,
    route((req) => {
      if (!req.body || Object.keys(req.body).some((k) => k !== "shortcut"))
        throw { code: "desktop_hotkey_invalid" };
      return desktop.execute("native.hotkey", req.body);
    }),
  );
  app.post(
    "/api/control-deck/windows/media",
    execute,
    route((req) => {
      if (
        !req.body ||
        Object.keys(req.body).some((k) => k !== "key") ||
        !["playPause", "next", "previous", "stop"].includes(req.body.key)
      )
        throw { code: "desktop_media_invalid" };
      return desktop.execute("native.media", req.body);
    }),
  );
  app.post(
    "/api/control-deck/integrations/twitch-clips/configure",
    edit,
    route((req) => {
      if (!getTwitchClips()) throw { code: "twitch_integration_unavailable" };
      return getTwitchClips().configure(req.body);
    }),
  );
  app.post(
    "/api/control-deck/integrations/twitch-clips/preview",
    edit,
    route((req) => {
      if (!getTwitchClips()) throw { code: "twitch_integration_unavailable" };
      return getTwitchClips().previewTitle(req.body);
    }),
  );
  app.post(
    "/api/control-deck/integrations/twitch-clips/authorize",
    edit,
    route(() => {
      if (!getTwitchClips()) throw { code: "twitch_integration_unavailable" };
      return getTwitchClips().beginAuthorization();
    }),
  );
  app.post(
    "/api/control-deck/integrations/twitch-clips/poll",
    edit,
    route(() => {
      if (!getTwitchClips()) throw { code: "twitch_integration_unavailable" };
      return getTwitchClips().pollAuthorization();
    }),
  );
};
