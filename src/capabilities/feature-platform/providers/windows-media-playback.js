/** Targeted, bounded media-session commands. Use explicit play/pause operations,
 * never a global media-key toggle which could control another application.
 * Arguments are allowlisted and passed directly to PowerShell, not shell source.
 */
module.exports = function windowsMediaPlayback({ spawn, observerPath, supported }) {
  let pending = null;
  let cancel = null;
  const control = (payload) => {
    if (
      !supported ||
      !["tidal", "spotify", "apple-music"].includes(payload.provider) ||
      !["pause", "resume"].includes(payload.action)
    )
      return Promise.resolve({ ok: false, error: "media_control_unavailable" });
    if (pending) return Promise.resolve({ ok: false, error: "media_control_busy" });
    pending = new Promise((resolve) => {
      let child,
        output = "",
        finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child?.kill();
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "media_control_timeout" }), 8000);
      cancel = () => finish({ ok: false, error: "media_control_stopped" });
      try {
        child = spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            observerPath,
            "-Provider",
            payload.provider,
            "-Action",
            payload.action,
            "-Once",
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.length > 2048) finish({ ok: false, error: "media_control_invalid_response" });
        });
        child.stderr.resume();
        child.on("error", () => finish({ ok: false, error: "media_control_unavailable" }));
        child.on("close", () => {
          try {
            const value = JSON.parse(output.trim());
            finish(
              value.ok === true
                ? { ok: true, accepted: true }
                : { ok: false, error: value.error || "media_control_unavailable" },
            );
          } catch {
            finish({ ok: false, error: "media_control_unavailable" });
          }
        });
      } catch {
        finish({ ok: false, error: "media_control_unavailable" });
      }
    }).finally(() => {
      pending = null;
      cancel = null;
    });
    return pending;
  };
  control.close = () => cancel?.();
  return control;
};
