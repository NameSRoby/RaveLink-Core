/** Private macro configuration and cancellable, single-flight button lifetimes. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { validate, defaults, fault } = require("./control-deck-config");
const { validateValue } = require("../../shared/contracts/bounded-json-schema");
module.exports = function createControlDeck({ runtimeDir, actions, widgets, now = Date.now }) {
  const file = path.join(runtimeDir, "system", "control-deck.json");
  let config = defaults(),
    revision = 0,
    closed = false,
    audioPageAdded = true;
  const running = new Map(),
    states = new Map();
  const live = require("./control-deck-live")({
    read: () => ({
      snapshot: snapshot(),
      catalog: { actions: actions.catalog(), modGuidance: actions.guidance?.() || "" },
    }),
    refresh: refreshLive,
    subscribe: actions.subscribe,
  });
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 300000) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      config = validate(saved.config);
      audioPageAdded = saved.audioPageAdded === true;
      revision = Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0;
    }
  } catch {
    /* A new or corrupt local layout starts with usable controls. */
  }
  const migrated = require("./retire-discord-controls")(config);
  if (!audioPageAdded) {
    migrated.pages = require("./audio-mixer-page").ensure(migrated.pages);
    audioPageAdded = true;
  }
  if (JSON.stringify(migrated) !== JSON.stringify(config)) save(migrated, revision);
  function refreshLive() {
    void widgets?.refresh(config);
    return actions.refreshLive?.() || actions.refresh?.();
  }
  function snapshot() {
    return {
      revision,
      config: structuredClone(config),
      running: [...running.values()].map(({ runId, buttonId, step, total, startedAt }) => ({
        runId,
        buttonId,
        step,
        total,
        startedAt,
      })),
      states: Object.fromEntries([...states].map(([id, state]) => [id, { ...state }])),
      actionStates: actions.feedback?.() || {},
      windowsAudio: actions.windowsAudio?.(),
      widgetData: widgets?.snapshot(),
    };
  }
  function save(value, expected) {
    if (closed) throw fault("control_deck_closed");
    if (expected !== revision) throw fault("control_deck_revision_conflict");
    const next = validate(value);
    if (running.size) throw fault("control_deck_busy");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file + ".tmp",
      JSON.stringify({ version: 1, revision: revision + 1, audioPageAdded, config: next }) + "\n",
      { mode: 0o600 },
    );
    fs.renameSync(file + ".tmp", file);
    const prior = new Map(
      config.pages.flatMap((page) =>
        page.buttons.map((button) => [
          button.id,
          JSON.stringify([button.kind, button.steps, button.alternateSteps, button.holdSteps]),
        ]),
      ),
    );
    for (const button of next.pages.flatMap((page) => page.buttons))
      if (
        prior.get(button.id) !==
        JSON.stringify([button.kind, button.steps, button.alternateSteps, button.holdSteps])
      )
        states.delete(button.id);
    config = next;
    revision++;
    live.changed();
    const ids = new Set(config.pages.flatMap((p) => p.buttons.map((b) => b.id)));
    for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
    return snapshot();
  }
  function delay(ms, signal) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        reject(fault("control_deck_cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }
  function describe(steps) {
    const catalog = new Map(actions.catalog().map((a) => [a.id, a]));
    return steps.map((step) => {
      const item = catalog.get(step.actionId);
      if (!item?.available) throw fault("control_deck_action_unavailable");
      if (!validateValue(item.parameters || {}, step.params))
        throw fault("control_deck_parameters_invalid");
      return item;
    });
  }
  async function perform(run, button, steps) {
    let successful = false,
      code = "completed";
    try {
      for (const [index, step] of steps.entries()) {
        if (closed || run.controller.signal.aborted) throw fault("control_deck_cancelled");
        run.step = index + 1;
        await delay(step.delayMs, run.controller.signal);
        describe([step]); // Revoked grants, disabled mods and changed routes stay authoritative.
        const result = await actions.execute(
          step.actionId,
          structuredClone(step.params),
          run.controller.signal,
        );
        if (result?.ok === false || result?.value?.ok === false) {
          const detail = result.value || result,
            code = detail.reason || detail.code || detail.error?.code || detail.error;
          throw fault(
            typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code)
              ? code
              : "control_deck_action_failed",
          );
        }
      }
      successful = !run.controller.signal.aborted;
      if (!successful) code = "control_deck_cancelled";
    } catch (error) {
      code = /^[a-z][a-z0-9_]{0,79}$/.test(error?.code || "")
        ? error.code
        : "control_deck_action_failed";
    } finally {
      const old = states.get(button.id) || { toggled: false };
      states.set(button.id, {
        toggled:
          successful && button.alternateSteps.length && run.trigger === "press"
            ? !old.toggled
            : old.toggled,
        lastResult: { ok: successful, code },
        lastRunAt: now(),
      });
      running.delete(run.runId);
      live.changed();
    }
  }
  function execute(buttonId, trigger = "press", value) {
    if (closed) throw fault("control_deck_closed");
    if (!["press", "hold"].includes(trigger)) throw fault("control_deck_trigger_invalid");
    const button = config.pages.flatMap((p) => p.buttons).find((b) => b.id === buttonId);
    if (!button || !["macro", "slider"].includes(button.kind))
      throw fault("control_deck_button_invalid");
    if (running.size >= 8 || [...running.values()].some((r) => r.buttonId === buttonId))
      throw fault("control_deck_busy");
    const steps = structuredClone(
      trigger === "hold"
        ? button.holdSteps
        : states.get(button.id)?.toggled && button.alternateSteps.length
          ? button.alternateSteps
          : button.steps,
    );
    if (button.kind === "slider") {
      const action = actions.catalog().find((a) => a.id === steps[0].actionId),
        control = action?.control;
      if (
        trigger !== "press" ||
        control?.type !== "slider" ||
        typeof control.parameter !== "string" ||
        !Number.isFinite(value) ||
        value < control.min ||
        value > control.max ||
        Math.abs(
          (value - control.min) / control.step - Math.round((value - control.min) / control.step),
        ) > 1e-6
      )
        throw fault("control_deck_slider_invalid");
      steps[0].params[control.parameter] = value;
    } else if (value !== undefined) throw fault("control_deck_slider_invalid");
    if (!steps.length) throw fault("control_deck_trigger_empty");
    const descriptors = describe(steps);
    const run = {
      runId: crypto.randomBytes(12).toString("hex"),
      buttonId,
      trigger,
      controller: new AbortController(),
      step: 0,
      total: steps.length,
      startedAt: now(),
      promise: null,
    };
    running.set(run.runId, run);
    live.changed();
    run.promise = Promise.resolve().then(() =>
      perform(run, structuredClone(button), structuredClone(steps)),
    );
    return {
      runId: run.runId,
      buttonId,
      ...(steps.length === 1 && descriptors[0].navigation
        ? { navigation: descriptors[0].navigation }
        : {}),
    };
  }
  function cancel(runId) {
    if (runId !== undefined && (typeof runId !== "string" || !/^[a-f0-9]{24}$/.test(runId)))
      throw fault("control_deck_run_invalid");
    let cancelled = 0;
    for (const run of running.values())
      if (!runId || run.runId === runId) {
        run.controller.abort();
        cancelled++;
      }
    return { cancelled };
  }
  async function shutdown() {
    closed = true;
    live.close();
    cancel();
    await Promise.allSettled([...running.values()].map((r) => r.promise));
  }
  return Object.freeze({
    snapshot,
    save,
    execute,
    cancel,
    refresh: actions.refresh,
    refreshLive,
    live,
    catalog: () => ({ actions: actions.catalog(), modGuidance: actions.guidance?.() || "" }),
    shutdown,
  });
};
