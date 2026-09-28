const clean = (value, maximum) => typeof value === "string"
  ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ")).slice(0, maximum).join("").trim()
  : "";

function createVisualAlertEngine(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const cancel = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  let current = null;
  let revision = 0;
  let timer = null;
  let sequence = 0;

  function snapshot() {
    return { ok: true, revision, alert: current ? { ...current } : null };
  }

  function changed(reason) {
    revision += 1;
    onChange({ reason, revision });
  }

  function clear(reason = "dismissed") {
    if (timer) cancel(timer);
    timer = null;
    if (!current) return { ok: true, dismissed: false, revision };
    current = null;
    changed(reason);
    return { ok: true, dismissed: true, revision };
  }

  function show(input = {}) {
    const name = clean(input.name, 80) || "Anonymous supporter";
    const message = clean(input.message, 500);
    const theme = ["clean", "celebration", "minimal"].includes(input.theme) ? input.theme : "clean";
    const durationMs = Math.max(2000, Math.min(30000, Number.isInteger(input.durationMs) ? input.durationMs : 6000));
    if (timer) cancel(timer);
    const startedAt = now();
    current = { id: `visual-${++sequence}`, name, message, theme, startedAt, expiresAt: startedAt + durationMs };
    changed("shown");
    timer = schedule(() => {
      timer = null;
      if (current?.expiresAt <= now()) clear("expired");
    }, durationMs);
    timer.unref?.();
    return { ok: true, shown: true, revision, expiresAt: current.expiresAt };
  }

  function stop() {
    if (timer) cancel(timer);
    timer = null;
    current = null;
  }

  return Object.freeze({ snapshot, show, clear, stop });
}

module.exports = { createVisualAlertEngine };
