/** LEDs describe confirmed owner state. A macro result is only a brief receipt. */
const SUCCESS_MS = 700;
const colors = {
  active: "#27c58a",
  paused: "#edb449",
  pending: "#edb449",
  error: "#ed5268",
  unknown: "#8190a8",
  inactive: "#8190a8",
  mixed: "#edb449",
};
function ownerState(value, now, lastRunAt) {
  if (typeof value === "boolean") return { tone: value ? "active" : "inactive" };
  if (!value || typeof value !== "object") return null;
  const name = value.tone || value.status || value.state;
  if (name === "success" || (name === "error" && Number.isFinite(value.completedAt))) {
    const age = now - (value.completedAt ?? lastRunAt);
    if (!Number.isFinite(age) || age < 0 || age >= (name === "success" ? SUCCESS_MS : 8000))
      return { tone: "rest" };
  }
  const tone = ["error", "failed", "failure", "unavailable", "disconnected"].includes(name)
    ? "error"
    : ["pending", "running", "busy"].includes(name)
      ? "pending"
      : ["paused", "muted", "deafened", "held"].includes(name)
        ? "paused"
        : name === "mixed"
          ? "mixed"
          : ["unknown", "unconfirmed"].includes(name)
            ? "unknown"
            : ["inactive", "off", "idle"].includes(name)
              ? "inactive"
              : [
                    "active",
                    "success",
                    "ready",
                    "unmuted",
                    "listening",
                    "connected",
                    "playing",
                    "enabled",
                  ].includes(name)
                ? "active"
                : null;
  if (!tone) return null;
  return {
    tone,
    ...(["success", "error"].includes(name) && Number.isFinite(value.completedAt)
      ? { expiresAt: value.completedAt + (name === "success" ? SUCCESS_MS : 8000) }
      : {}),
    ...(typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
      ? { color: value.color }
      : {}),
  };
}
export function deckIndicator({
  button,
  catalog,
  running,
  pending,
  state,
  stale = false,
  now = Date.now(),
}) {
  const finish = (tone, label, color) => ({ tone, label, color: color || colors[tone] || "" });
  if (stale) return finish("unknown", "Status connection lost");
  if (running || pending) return finish("pending", "Running");
  if (button.kind === "folder") return finish("rest", "Open page");
  const receipt = () => ({
    ...finish("active", "Completed"),
    expiresAt: state.lastRunAt + SUCCESS_MS,
  });
  const age = now - state?.lastRunAt,
    recent = Number.isFinite(age) && age >= 0;
  if (recent && age < 8000 && state.lastResult?.ok === false)
    return state.lastResult.code === "control_deck_cancelled"
      ? finish("inactive", "Cancelled")
      : { ...finish("error", "Failed"), expiresAt: state.lastRunAt + 8000 };
  const branching = !!(button.alternateSteps?.length || button.holdSteps?.length);
  const steps = [
    ...(button.steps || []),
    ...(button.alternateSteps || []),
    ...(button.holdSteps || []),
  ];
  const actions = steps.map((step) => catalog.find((action) => action.id === step.actionId));
  const live = actions.map(
    (action) =>
      ownerState(action?.state, now, state?.lastRunAt) ||
      (action?.stateful ? { tone: "unknown" } : null),
  );
  // Unconfirmed state is neutral even when the action is disabled for that reason.
  if (
    actions.some(
      (action, i) => (!action || action.available === false) && live[i]?.tone !== "unknown",
    )
  )
    return finish("error", "Unavailable");
  const known = live.filter(Boolean);
  const nextExpiry = Math.min(...known.map((value) => value.expiresAt).filter(Number.isFinite));
  for (const tone of ["error", "pending", "unknown"])
    if (known.some((value) => value.tone === tone))
      return finish(
        tone,
        tone === "error"
          ? "Unavailable or failed"
          : tone === "pending"
            ? "Awaiting confirmation"
            : "State unknown",
        known.length === 1 ? known[0].color : "",
      );
  if (button.toggleStates && button.alternateSteps?.length) {
    const selected = button.toggleStates[state?.toggled ? "on" : "off"];
    return finish(state?.toggled ? "active" : "inactive", selected.label, selected.color);
  }
  if (branching)
    return recent && age < SUCCESS_MS && state.lastResult?.ok === true
      ? receipt()
      : finish("rest", "Ready");
  if (actions.length > 1 && known.length > 0 && known.length < actions.length)
    return recent && age < SUCCESS_MS && state.lastResult?.ok === true
      ? receipt()
      : finish("unknown", "Some states unknown");
  if (known.length) {
    const tones = new Set(known.map((value) => value.tone));
    const tone = tones.size > 1 ? "mixed" : known[0].tone;
    if (tone === "rest") return finish("rest", "Ready");
    return {
      ...finish(
        tone,
        tone === "active"
          ? "Active / ready"
          : tone === "paused"
            ? "Paused / muted"
            : tone === "mixed"
              ? "Mixed states"
              : "Inactive",
        known.length === 1 ? known[0].color : "",
      ),
      ...(Number.isFinite(nextExpiry) ? { expiresAt: nextExpiry } : {}),
    };
  }
  if (recent && age < SUCCESS_MS && state.lastResult?.ok === true) return receipt();
  return finish("rest", "Ready");
}
