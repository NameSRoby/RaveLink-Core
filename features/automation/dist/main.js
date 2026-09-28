const { createAnimationEngine } = require("./animation-engine");
const { normalizeSettings, previewDonation } = require("./donation-policy");
const { createVisualAlertEngine } = require("./visual-alert-engine");

let context;
let animations;
let donationSettings;
let visualAlerts;
let shuttingDown = false;
let dirty = false;
let persistTimer;
const pending = new Set();

function track(promise) {
  const operation = Promise.resolve(promise);
  pending.add(operation);
  operation.finally(() => pending.delete(operation)).catch(() => {});
  return operation;
}

async function persist() {
  if (!dirty || !context) return;
  dirty = false;
  try {
    await context.callCapability("ravelink.storage.v1", "set", { key: "automation-state-v1", value: {
      version: 4, animations: animations.exportSnapshot(), donationSettings
    } }, { timeoutMs: 1000 });
  } catch {
    dirty = true;
  }
}

function schedulePersist() {
  dirty = true;
  if (persistTimer || shuttingDown) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, 1000);
  persistTimer.unref?.();
}

async function executeAnimation(payload) {
  if (shuttingDown) return { ok: false, error: "automation_stopping" };
  return context.callCapability("lighting.output.v1", "apply", payload, { timeoutMs: 6000 });
}

async function activate(nextContext) {
  context = nextContext;
  shuttingDown = false;
  dirty = false;
  donationSettings = normalizeSettings();
  visualAlerts = createVisualAlertEngine({ onChange(event) {
    context?.publishEvent("alerts.visual.events.v1", "changed", event);
  } });
  animations = createAnimationEngine({ apply: executeAnimation, onChange(reason) {
    schedulePersist();
    context?.publishEvent("automation.animation.execution.events.v1", "changed", { reason, revision: animations?.snapshot().revision || 0 });
  } });
  try {
    const stored = await context.callCapability("ravelink.storage.v1", "get", { key: "automation-state-v1" }, { timeoutMs: 1000 });
    if (stored?.ok && stored.found) {
      if ([2, 3, 4].includes(stored.value?.version)) animations.importSnapshot(stored.value.animations);
      donationSettings = normalizeSettings(stored.value?.donationSettings);
    }
  } catch {}
}

async function handleRequest(request) {
  if (request.capability === "alerts.tts.setup.v1") {
    if (request.method === "status") {
      try {
        const result = await context.callCapability("alerts.tts.packages.v1", "status", {}, { timeoutMs: 12000 });
        return { ok: true, providerAvailable: true, packages: Array.isArray(result?.packages) ? result.packages : [], warnings: Number(result?.warnings || 0) };
      } catch { return { ok: true, providerAvailable: false, packages: [], warnings: 0 }; }
    }
    if (request.method === "manage") {
      const action = String(request.payload?.action || "");
      const method = { install: "install", update: "update", remove: "remove" }[action];
      if (!method) return { ok: false, featureId: String(request.payload?.featureId || ""), code: "tts_package_action_invalid" };
      try {
        return await context.callCapability("alerts.tts.packages.v1", method, { featureId: request.payload.featureId, deleteData: request.payload.deleteData === true }, { timeoutMs: 30000 });
      } catch { return { ok: false, featureId: String(request.payload?.featureId || ""), code: "tts_package_manager_unavailable" }; }
    }
  }
  if (request.capability === "alerts.visual.read.v1" && request.method === "status") return visualAlerts.snapshot();
  if (request.capability === "alerts.visual.admin.v1") {
    if (request.method === "dismiss") return visualAlerts.clear();
    if (request.method === "test") {
      const preview = previewDonation(request.payload || {}, donationSettings);
      if (!preview.outputs.overlay) return { ok: true, shown: false, code: "visual_alert_disabled", revision: visualAlerts.snapshot().revision };
      const shown = visualAlerts.show({ ...preview.outputs.overlay, theme: request.payload?.theme, durationMs: request.payload?.durationMs });
      return { ...shown, code: "visual_alert_shown" };
    }
  }
  if (request.capability === "alerts.donation.settings.v1") {
    if (request.method === "status") return { ok: true, settings: donationSettings, stage: "preview_only" };
    if (request.method === "save") {
      donationSettings = normalizeSettings(request.payload);
      schedulePersist();
      return { ok: true, settings: donationSettings, stage: "preview_only" };
    }
    if (request.method === "preview") return previewDonation(request.payload || {}, donationSettings);
  }
  if (request.capability === "automation.animation.profiles.read.v1" && request.method === "status") {
    let fixtures = [];
    let twitch = { ok: false, error: "twitch_integration_unavailable", rewards: [] };
    try {
      const result = await context.callCapability("lighting.output.v1", "apply", { action: "catalog" }, { timeoutMs: 1500 });
      if (result?.ok && Array.isArray(result.fixtures)) fixtures = result.fixtures;
    } catch {}
    try {
      const result = await context.callCapability("twitch.rewards.catalog.v1", "list", {}, { timeoutMs: 6000 });
      if (result?.ok) twitch = result;
      else if (result) twitch = { ...result, rewards: [] };
    } catch {}
    return { ...animations.snapshot(fixtures), twitch };
  }
  if (request.capability === "automation.animation.profiles.admin.v1" && request.method === "mutate") {
    const result = animations.mutate(request.payload || {});
    if (result.ok) schedulePersist();
    return result;
  }
  if (request.capability === "automation.animation.execution.admin.v1" && request.method === "start") {
    if (pending.size >= 4) return { ok: false, code: "automation_busy" };
    const result = await track(animations.start(request.payload || {}));
    schedulePersist();
    return result;
  }
  if (request.capability === "automation.animation.execution.admin.v1" && request.method === "cancel") return animations.cancel(request.payload || {});
  if (request.capability === "automation.animation.execution.admin.v1" && request.method === "cancel-all") return animations.cancelAll();
  if (request.capability === "automation.twitch.events.v1" && request.method === "receive") {
    const observed = animations.observeTrigger(request.payload || {});
    schedulePersist();
    if (observed.duplicate) return { ok: true, handled: true, code: observed.code };
    const match = animations.matchTrigger(request.payload || {});
    if (!match.profile) return match;
    const profile = match.profile;
    if (!match.ok) return { ...match, profile: undefined, profileId: profile.id };
    if (pending.size >= 4) return { ok: false, handled: true, code: "automation_busy", profileId: profile.id };
    const admission = animations.canStart(profile.id);
    if (!admission.ok) return { ...admission, handled: true, profileId: profile.id };
    animations.acceptTrigger(profile.id);
    track(animations.start({ profileId: profile.id })).then(() => schedulePersist()).catch(() => {});
    return { ok: true, handled: true, code: "automation_animation_queued", profileId: profile.id };
  }
  throw new Error("method_unavailable");
}

async function deactivate() {
  animations?.cancelAll?.();
  visualAlerts?.stop?.();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  await Promise.allSettled([...pending]);
  shuttingDown = true;
  await persist();
  context = null;
  animations = null;
  donationSettings = null;
  visualAlerts = null;
}

module.exports = { activate, deactivate, handleRequest };
