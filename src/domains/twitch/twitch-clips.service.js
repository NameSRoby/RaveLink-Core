/** One Core-owned live-clip job. A 202 response means pending, never success.
 * Confirmation uses Get Clips; POST is not retried after an uncertain network
 * result. Chat and deck requests share the same cooldown and single-flight job.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  DEFAULT_GROUPS,
} = require("../../capabilities/feature-platform/providers/twitch-permission-groups");
const moderation = require("./clip-title-moderation");
const defaults = () => ({
  chatEnabled: false,
  chatAccess: "everyone",
  titleModeration: moderation.defaults(),
});
const text = (value, max) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const errors = {
  twitch_not_connected: "Connect Twitch",
  twitch_scope_missing: "Grant clip access",
  twitch_reauthorization_required: "Reconnect Twitch",
  twitch_clips_disabled: "Clips unavailable on channel",
  twitch_stream_offline: "Stream is offline",
  twitch_clip_rate_limited: "Twitch clip limit reached",
  twitch_clip_not_confirmed: "Clip was not confirmed",
  twitch_clip_input_invalid: "Check the clip title and duration",
  twitch_clip_create_failed: "Clip request failed",
  twitch_clip_response_invalid: "Clip request was not confirmed",
  twitch_clip_lookup_failed: "Clip confirmation unavailable",
  twitch_request_timeout: "Clip request was not confirmed",
  twitch_network_unavailable: "Twitch connection unavailable",
};
module.exports = function createTwitchClips({
  getProvider,
  storePath,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  confirmationMs = 60000,
} = {}) {
  if (typeof getProvider !== "function") throw Error("twitch_clip_provider_required");
  let config = defaults(),
    job = null,
    pending = null,
    waiting = null,
    closed = false,
    nextAllowedAt = 0;
  const handled = new Map();
  function valid(value) {
    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((k) =>
        ["chatEnabled", "chatAccess", "titleModeration"].includes(k),
      ) &&
      typeof value.chatEnabled === "boolean" &&
      ["everyone", "moderators"].includes(value.chatAccess)
    );
  }
  try {
    if (storePath) {
      const stat = fs.lstatSync(storePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 98304) throw Error();
      const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (stored.version === 1 && valid(stored.config))
        config = {
          ...stored.config,
          titleModeration: moderation.normalizePolicy(stored.config.titleModeration),
        };
    }
  } catch {
    /* New/invalid preferences keep chat disabled. */
  }
  function connection() {
    const state = getProvider().status();
    return {
      connected: state.connected === true,
      scopeGranted: state.scopes?.includes("clips:edit") === true,
      chatReplyAvailable:
        state.connected === true && state.scopes?.includes("user:write:chat") === true,
      chatAvailable:
        state.connected === true &&
        state.scopes?.includes("user:read:chat") === true &&
        state.eventSub?.connected === true &&
        state.eventSub.subscriptions?.includes("channel.chat.message") === true,
    };
  }
  function status() {
    const auth = connection(),
      available = !closed && auth.connected && auth.scopeGranted;
    const feedback = !available
      ? {
          state: "error",
          label: !auth.connected ? "Connect Twitch" : "Grant clip access",
          active: false,
          color: "#c82d50",
        }
      : job?.state === "pending"
        ? { state: "pending", label: "Creating clip…", active: true, color: "#d99a28" }
        : job?.state === "success"
          ? { state: "success", label: "Clip created", active: false, color: "#21a97d" }
          : job?.state === "error"
            ? {
                state: "error",
                label: errors[job.error] || "Clip unavailable",
                active: false,
                color: "#c82d50",
              }
            : { state: "ready", label: "Clip stream", active: false, color: "#7547b9" };
    return {
      ok: true,
      available,
      connected: auth.connected,
      chatAvailable: auth.chatAvailable,
      chatReplyAvailable: auth.chatReplyAvailable,
      scopeGranted: auth.scopeGranted,
      config: structuredClone(config),
      cooldownSeconds: Math.max(0, Math.ceil((nextAllowedAt - now()) / 1000)),
      job: job ? { ...job } : null,
      feedback: {
        ...feedback,
        available,
        ...(available && job ? { jobId: job.id } : {}),
        ...(available && ["success", "error"].includes(job?.state)
          ? { completedAt: job.completedAt }
          : {}),
      },
    };
  }
  function configure(input) {
    const next = { ...config, ...input };
    if (!input || typeof input !== "object" || Array.isArray(input) || !valid(next))
      throw Object.assign(Error("twitch_clip_config_invalid"), {
        code: "twitch_clip_config_invalid",
      });
    next.titleModeration = moderation.normalizePolicy(
      input.titleModeration,
      config.titleModeration,
    );
    if (storePath) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath + ".tmp", JSON.stringify({ version: 1, config: next }) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(storePath + ".tmp", storePath);
    }
    config = next;
    return status();
  }
  function pause() {
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        waiting = null;
        resolve();
      }, 1000);
      timer.unref?.();
      waiting = { timer, resolve };
    });
  }
  async function perform(current, reply) {
    try {
      const result = await getProvider().createClip({
        ...(current.title ? { title: current.title } : {}),
        duration: current.duration,
      });
      if (closed || job !== current) return;
      if (!result?.ok) throw Error(result?.error || "twitch_clip_create_failed");
      current.clipId = text(result.id, 200);
      current.url = text(result.url, 1000);
      current.editUrl = text(result.editUrl, 1000);
      const deadline = now() + Math.max(1000, Math.min(60000, confirmationMs));
      for (let checks = 0; checks < 61 && !closed && job === current; checks++) {
        const clip = await getProvider().getClip({ id: current.clipId });
        if (closed || job !== current) return;
        if (clip?.ok && clip.found) {
          current.state = "success";
          current.completedAt = now();
          current.title = text(clip.title || current.title, 100);
          if (reply && config.chatEnabled)
            await getProvider().sendChat({
              message: "Clip created: " + current.url,
              replyParentMessageId: reply,
            });
          return;
        }
        if (
          clip &&
          !clip.ok &&
          [
            "twitch_not_connected",
            "twitch_scope_missing",
            "twitch_reauthorization_required",
          ].includes(clip.error)
        )
          throw Error(clip.error);
        if (now() >= deadline) break;
        await pause();
      }
      if (!closed) throw Error("twitch_clip_not_confirmed");
    } catch (error) {
      if (closed || job !== current || current.state === "success") return;
      current.state = "error";
      current.completedAt = now();
      current.error = Object.hasOwn(errors, error.message)
        ? error.message
        : "twitch_clip_not_confirmed";
    }
  }
  function create(input = {}, reply = "") {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["title", "duration"].includes(k)) ||
      (input.title !== undefined &&
        (typeof input.title !== "string" || input.title.length > 100)) ||
      (input.duration !== undefined &&
        (!Number.isFinite(input.duration) ||
          input.duration < 5 ||
          input.duration > 60 ||
          !Number.isInteger(input.duration * 10)))
    )
      return { ok: false, error: "twitch_clip_input_invalid" };
    const title = moderation.moderateTitle(input.title || "", config.titleModeration);
    if (!title.accepted) return { ok: false, error: title.error };
    const state = status();
    if (!state.available)
      return {
        ok: false,
        error: !state.connected ? "twitch_not_connected" : "twitch_scope_missing",
      };
    if (pending) return { ok: false, error: "twitch_clip_busy", feedback: state.feedback };
    if (now() < nextAllowedAt)
      return { ok: false, error: "twitch_clip_cooldown", cooldownSeconds: state.cooldownSeconds };
    nextAllowedAt = now() + 30000;
    job = {
      id: crypto.randomBytes(12).toString("hex"),
      state: "pending",
      title: title.title,
      titleModerated: title.matched,
      duration: input.duration ?? 30,
      startedAt: now(),
      completedAt: 0,
      clipId: "",
      url: "",
      editUrl: "",
      error: "",
    };
    const current = job;
    pending = Promise.resolve()
      .then(() => perform(current, reply))
      .finally(() => {
        pending = null;
      });
    return { ok: true, pending: true, jobId: current.id, feedback: status().feedback };
  }
  function previewTitle(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["title", "titleModeration"].includes(k)) ||
      typeof input.title !== "string" ||
      input.title.length > 100
    )
      throw Object.assign(Error("twitch_clip_input_invalid"), {
        code: "twitch_clip_input_invalid",
      });
    return moderation.moderateTitle(
      input.title,
      moderation.normalizePolicy(input.titleModeration, config.titleModeration),
    );
  }
  async function handleChat(event = {}) {
    const message = text(event.message?.text || event.text, 300),
      match = /^!clip(?:\s+(.+))?$/i.exec(message);
    if (!config.chatEnabled || !match) return { handled: false };
    const state = getProvider().status();
    const messageId = text(event.message_id, 160);
    if (!messageId || event.broadcaster_user_id !== state.userId)
      return { handled: true, accepted: false, error: "twitch_clip_channel_invalid" };
    const moderator =
      event.chatter_user_id === event.broadcaster_user_id ||
      event.badges?.some((b) => ["broadcaster", "moderator"].includes(b.set_id || b.id));
    if (config.chatAccess === "moderators" && !moderator)
      return { handled: true, accepted: false, error: "twitch_clip_role_required" };
    if (handled.has(messageId))
      return { handled: true, accepted: false, error: "twitch_clip_message_replayed" };
    while (handled.size >= 256) handled.delete(handled.keys().next().value);
    handled.set(messageId, now());
    const result = create({ ...(match[1] ? { title: match[1].slice(0, 100) } : {}) }, messageId);
    return { handled: true, accepted: result.ok === true, ...result };
  }
  const authResult = (state) => ({
    ok: state.ok !== false,
    connected: state.connected === true,
    userCode: text(state.userCode, 64),
    verificationUri: /^https:\/\/(?:www\.)?twitch\.tv\//.test(state.verificationUri || "")
      ? text(state.verificationUri, 1000)
      : "",
    expiresAt: state.authorizationExpiresAt || 0,
    ...(state.error ? { error: text(state.error, 100) } : {}),
  });
  return {
    status,
    configure,
    previewTitle,
    create,
    handleChat,
    beginAuthorization: async () =>
      authResult(
        await getProvider().begin({
          permissionGroups: [
            ...new Set([
              ...(getProvider().status().selectedPermissionGroups || DEFAULT_GROUPS),
              "clips",
            ]),
          ],
        }),
      ),
    pollAuthorization: async () => authResult(await getProvider().poll()),
    async shutdown() {
      closed = true;
      if (waiting) {
        clearTimer(waiting.timer);
        waiting.resolve();
        waiting = null;
      }
      await pending;
    },
  };
};
