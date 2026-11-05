/** Pace failed embeds and bind asynchronous events to their original lease.
 * Autoplay denial is not a failed request. Only explicit Start clears a stop. */
/* exported createYoutubePlaybackGuard */
function createYoutubePlaybackGuard({
  current,
  videoId,
  acknowledge,
  pull,
  refresh,
  notice,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let failures = 0,
    blocked = false,
    retryAt = 0,
    terminal = null,
    startedLease = null;
  let timer = null,
    stopped = false,
    starting = null,
    autoplayWait = false;
  function matches(active) {
    const observed = videoId();
    return (
      active && current() === active && (!observed || observed === active.candidate.providerItemId)
    );
  }
  function stop(message) {
    blocked = true;
    cancel(timer);
    timer = null;
    notice(message, true);
  }
  async function started() {
    const active = current();
    if (autoplayWait && matches(active)) {
      blocked = false;
      autoplayWait = false;
    }
    if (blocked || terminal || !matches(active) || startedLease === active) return;
    if (starting) return starting;
    starting = Promise.resolve()
      .then(() => acknowledge("started", active))
      .then((result) => {
        if (result?.ok && current() === active) startedLease = active;
        else if (current() === active)
          stop(
            "Playback could not be confirmed. Check the connection, then select Start Playback.",
          );
      })
      .catch(() => stop("Playback could not be confirmed. Select Start Playback to retry."))
      .finally(() => {
        starting = null;
      });
    return starting;
  }
  function finish(state, code = 0) {
    const active = current();
    if (blocked || terminal || !matches(active)) return Promise.resolve();
    if (state === "ended" && startedLease !== active) return Promise.resolve();
    const reasons = {
      2: "YouTube rejected the video ID.",
      5: "The browser could not play this video format.",
      100: "The video is unavailable or private.",
      101: "The uploader does not allow embedded playback.",
      150: "The uploader does not allow embedded playback.",
      153: "YouTube could not identify this local player.",
    };
    if (state === "failed" && (code === 153 || ![2, 5, 100, 101, 150].includes(code))) {
      stop(
        `${reasons[code] || "YouTube rejected playback."} Automatic playback is stopped. Your request is kept; check the player and select Start Playback.`,
      );
      return Promise.resolve();
    }
    if (state === "failed") {
      failures++;
      retryAt = now() + 2000;
      if (failures >= 3)
        stop(
          `${reasons[code] || "YouTube rejected playback."} Automatic playback is stopped; remaining requests are kept. Select Start Playback after checking the player.`,
        );
      else notice(`${reasons[code]} Error ${code}; trying the next request in two seconds.`, true);
    } else failures = 0;
    terminal = Promise.resolve()
      .then(async () => {
        await starting;
        const result = await acknowledge(state, active);
        if (!result?.ok) {
          stop(
            "The request outcome could not be confirmed. Automatic playback is stopped. Check the connection, then select Start Playback.",
          );
          return;
        }
        await refresh();
        if (stopped || blocked) return;
        cancel(timer);
        timer = schedule(
          () => {
            timer = null;
            if (!blocked && !stopped) void pull();
          },
          Math.max(0, retryAt - now()),
        );
      })
      .catch(() =>
        stop("The request outcome could not be confirmed. Select Start Playback to retry."),
      )
      .finally(() => {
        terminal = null;
      });
    return terminal;
  }
  return {
    canPull: () => !stopped && !blocked && !terminal && now() >= retryAt,
    started,
    async heartbeat(state) {
      const active = current();
      if (stopped || terminal || !matches(active)) return;
      if (state === 1 && !blocked) {
        await started();
        if (matches(active) && !terminal && !blocked) await acknowledge("progress", active);
      } else if (state === 2) await acknowledge("paused", active);
    },
    ended: () => finish("ended"),
    failed: (code) => finish("failed", Number(code) || 0),
    autoplayBlocked() {
      autoplayWait = true;
      stop(
        "Browser autoplay is blocked. Select Start Playback once to allow audio. Your request is kept.",
      );
    },
    resume() {
      if (terminal) return false;
      blocked = false;
      autoplayWait = false;
      failures = 0;
      retryAt = 0;
      startedLease = null;
      cancel(timer);
      timer = null;
      return !stopped;
    },
    dispose() {
      stopped = true;
      cancel(timer);
      timer = null;
    },
  };
}
