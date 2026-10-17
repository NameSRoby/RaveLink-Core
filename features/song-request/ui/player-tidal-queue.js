/**
 * Player tidal queue.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
/* exported renderTidalNowPlaying, renderTidalRequests */
const tidalModerationPending = new Set();
const tidalSongDurations = new Map();
function songDuration(key) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Song timeout duration");
  for (const [minutes, label] of [
    [1, "1 minute"],
    [5, "5 minutes"],
    [10, "10 minutes"],
    [30, "30 minutes"],
    [60, "1 hour"],
    [1440, "24 hours"],
  ])
    select.add(new Option(label, String(minutes)));
  select.value = String(tidalSongDurations.get(key) || 10);
  select.onchange = () => {
    tidalSongDurations.set(key, Number(select.value));
    if (tidalSongDurations.size > 250)
      tidalSongDurations.delete(tidalSongDurations.keys().next().value);
  };
  return select;
}
function renderTidalNowPlaying({ state, requesters, moderate, refresh }) {
  let controls = $("tidalNowControls");
  if (!controls) {
    controls = document.createElement("div");
    controls.id = "tidalNowControls";
    controls.className = "tidalNowControls";
    document.querySelector(".now").append(controls);
  }
  controls.hidden = !state;
  if (
    !state ||
    (controls.contains(document.activeElement) && document.activeElement.tagName === "SELECT")
  )
    return;
  const current = state.current,
    owner = current?.requesterKey
      ? requesters.get(current.requesterKey) || {
          displayName: current.requesterLabel,
        }
      : null;
  const signature = JSON.stringify([
    current,
    owner,
    state.controlsAvailable,
    [...tidalModerationPending],
  ]);
  if (controls.dataset.signature === signature) return;
  controls.dataset.signature = signature;
  controls.dataset.currentUid = current?.uid || "";
  controls.replaceChildren();
  const description = document.createElement("div");
  description.className = "currentRequester";
  description.textContent = owner
    ? "Requested by " + (owner.displayName || "Twitch user")
    : "No requester recorded for this song";
  const buttons = document.createElement("div");
  buttons.className = "currentSongActions";
  const run = async (payload) => {
    const key = "current:" + current.uid;
    if (tidalModerationPending.has(key)) return;
    tidalModerationPending.add(key);
    buttons.querySelectorAll("button,select").forEach((node) => {
      node.disabled = true;
    });
    const message = {
      block_song: "Current song banned.",
      timeout_song: "Current song timed out.",
      block: "Requester banned; their requests removed.",
      timeout: "Requester timed out; their requests removed.",
    }[payload.action];
    try {
      await moderate({ ...payload, currentUid: current.uid }, message);
    } finally {
      tidalModerationPending.delete(key);
      await refresh();
    }
  };
  const ban = actionButton(
    "BAN CURRENT SONG",
    "Ban the current track from requests and skip it in TIDAL",
    () => run({ action: "block_song" }),
    true,
  );
  ban.disabled = !current?.trackId || !state.controlsAvailable;
  if (ban.disabled)
    ban.title =
      "Connect or update the desktop companion in Setup to identify and control the current song";
  const songTime = songDuration(current?.trackId);
  const timeoutSong = actionButton(
    "TIMEOUT SONG",
    "Temporarily block this track and skip it",
    () => run({ action: "timeout_song", minutes: Number(songTime.value) }),
    true,
  );
  timeoutSong.disabled = songTime.disabled = ban.disabled;
  const duration = document.createElement("select");
  duration.setAttribute("aria-label", "Timeout duration for current requester");
  for (const [minutes, label] of [
    [1, "1 minute"],
    [5, "5 minutes"],
    [10, "10 minutes"],
    [30, "30 minutes"],
    [60, "1 hour"],
    [1440, "24 hours"],
  ])
    duration.add(new Option(label, String(minutes)));
  duration.value = String(timeoutDurations.get(current?.requesterKey) || 10);
  duration.disabled = !owner;
  duration.onchange = () => timeoutDurations.set(current.requesterKey, Number(duration.value));
  const timeout = actionButton(
    "TIMEOUT REQUESTER",
    "Time out the current requester and remove their songs",
    () =>
      run({
        action: "timeout",
        requesterKey: current.requesterKey,
        requesterName: owner.displayName || current.requesterLabel || "Twitch user",
        minutes: Number(duration.value),
        removePending: true,
      }),
    true,
  );
  timeout.disabled = !owner;
  if (!owner) timeout.title = "This song has no recorded requester to time out";
  const banUser = actionButton(
    "BAN REQUESTER",
    "Ban this requester and remove their songs",
    () =>
      run({
        action: "block",
        requesterKey: current.requesterKey,
        requesterName: owner.displayName || current.requesterLabel || "Twitch user",
        removePending: true,
      }),
    true,
  );
  banUser.disabled = !owner;
  buttons.append(
    moderationControls("Song & requester", [
      {
        title: "Song",
        description: current?.trackId ? "Current TIDAL recording" : "No track identified",
        controls: [songTime, timeoutSong, ban],
      },
      {
        title: "Requester",
        description: owner?.displayName || "No recorded requester",
        controls: [duration, timeout, banUser],
      },
    ]),
  );
  controls.append(description, buttons);
  if (current && tidalModerationPending.has("current:" + current.uid))
    buttons.querySelectorAll("button,select").forEach((node) => {
      node.disabled = true;
    });
}
function renderTidalRequests({ state, installation, requesters, refresh, refreshState, moderate }) {
  const heading = $("queueHeading"),
    body = $("queue");
  if (body.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
  let tools = $("tidalQueueTools");
  if (!tools) {
    tools = document.createElement("div");
    tools.id = "tidalQueueTools";
    tools.className = "tidalQueueTools";
    tools.innerHTML =
      '<span id="tidalCapacity" class="status"></span><label><input id="tidalShowRecent" type="checkbox"> Show recent deliveries</label>';
    heading.after(tools);
  }
  tools.hidden = false;
  $("tidalShowRecent").onchange = () =>
    renderTidalRequests({
      state,
      installation,
      requesters,
      refresh,
      refreshState,
      moderate,
    });
  const capacity = state?.capacity,
    waiting = state?.waiting ?? state?.queue?.length ?? 0;
  heading.textContent = `Requests · ${capacity?.queued || 0} / 10 in TIDAL · ${waiting} waiting`;
  $("tidalCapacity").textContent =
    state?.controlsAvailable === false
      ? "Update the companion in Setup to enable native removal and skipping."
      : capacity?.reported
        ? "Requests play in order, then your playlist resumes."
        : "Connect TIDAL in Setup.";
  const pending = state?.queue || [],
    receipts = state?.handoffs || [];
  const rows = [
    ...pending.map((entry) => ({
      ...entry,
      receipt: receipts.find((row) => row.entryId === entry.id),
      pending: true,
    })),
    ...receipts
      .filter((receipt) => !pending.some((entry) => entry.id === receipt.entryId))
      .map((receipt) => ({
        id: receipt.entryId,
        candidate: { title: receipt.title },
        ...receipt,
        receipt,
      })),
  ];
  const rank = (row) =>
    row.receipt?.phase === "playing"
      ? 0
      : row.receipt?.phase === "appended"
        ? 1
        : row.pending
          ? 2
          : 3;
  const signature = JSON.stringify([
    rows.map((row) => [
      row.id,
      row.candidate,
      row.requesterKey,
      row.requesterLabel,
      row.receipt?.phase,
      row.receipt?.lastError,
      row.deliveryError,
      row.pending,
    ]),
    [...requesters],
    capacity?.available,
    state?.connected,
    state?.ready,
    state?.delivery?.processing,
    installation?.version,
    $("tidalShowRecent").checked,
    [...tidalModerationPending],
  ]);
  if (body.dataset.signature === signature) return;
  body.dataset.signature = signature;
  body.replaceChildren();
  for (const entry of rows
    .filter((row) => row.receipt?.phase !== "finished" || $("tidalShowRecent").checked)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 25)) {
    const receipt = entry.receipt,
      phase = receipt?.phase;
    const row = body.insertRow();
    row.id = "tidal-request-" + entry.id;
    const track = row.insertCell();
    track.textContent = entry.candidate?.title || receipt?.title || receipt?.trackId || "Track";
    const artists = document.createElement("div");
    artists.className = "requesterMeta";
    artists.textContent = (entry.candidate?.artists || receipt?.artists || []).join(", ");
    track.append(artists);
    const owner = requesters.get(entry.requesterKey) || {
      requesterKey: entry.requesterKey,
      displayName: entry.requesterLabel || "Requester not recorded",
      role: entry.requesterRole || "viewer",
    };
    const user = row.insertCell();
    user.textContent = entry.requesterLabel || owner.displayName;
    const role = document.createElement("div");
    role.className = "requesterMeta";
    role.textContent =
      (owner.requesterKey
        ? owner.role || entry.requesterRole || ""
        : "Legacy delivery · user identity unavailable") +
      (owner.blocked ? " // BANNED" : owner.timedOutUntil > Date.now() ? " // TIMED OUT" : "");
    user.append(role);
    row.insertCell().textContent =
      phase === "playing"
        ? "Now playing"
        : phase === "appended"
          ? "Queued in TIDAL"
          : phase === "finished"
            ? receipt.moderated
              ? "Removed by moderator"
              : "No longer queued"
            : phase === "unknown"
              ? "Check delivery"
              : phase === "failed" && receipt.lastError !== "tidal_native_queue_full"
                ? "Held for retry"
                : entry.deliveryError === "tidal_delivery_in_progress"
                  ? "Sending"
                  : capacity?.available === 0
                    ? "Waiting for a slot"
                    : "Waiting to send";
    const actionCell = row.insertCell();
    actionCell.className = "rowActions";
    const actions = document.createElement("div");
    actionCell.append(actions);
    if (phase === "unknown") {
      const review = document.createElement("div");
      review.hidden = true;
      review.append(
        actionButton(
          "Not in TIDAL · allow retry",
          "Confirm absence in TIDAL before unlocking one explicit retry",
          async () => {
            try {
              await call("song.tidal.experimental.v1", "review", {
                entryId: entry.id,
                decision: "not-in-tidal",
              });
              await refresh();
            } catch (error) {
              setNotice(tidalErrorMessage(error), true);
            }
          },
        ),
      );
      actions.append(
        actionButton(
          "REVIEW DELIVERY",
          "Review an unconfirmed delivery without sending it again",
          () => {
            review.hidden = false;
          },
        ),
        review,
      );
    } else if (
      entry.pending &&
      ((entry.deliveryError && entry.deliveryError !== "tidal_delivery_in_progress") ||
        (phase === "failed" && receipt.lastError !== "tidal_native_queue_full"))
    ) {
      const retry = actionButton(
        "RETRY IN TIDAL",
        "Retry this held request once",
        async (event) => {
          event.currentTarget.disabled = true;
          try {
            await call("song.tidal.experimental.v1", "handoff", {
              entryId: entry.id,
            });
            await refresh();
            await refreshState();
          } catch (error) {
            setNotice(tidalErrorMessage(error), true);
            await refresh();
          }
        },
      );
      retry.disabled =
        !state?.connected ||
        !state?.ready ||
        state.delivery?.processing ||
        (installation?.installed && installation.version !== "0.1.6");
      actions.append(retry);
      const error = document.createElement("div");
      error.className = "requesterMeta";
      error.textContent = tidalErrorMessage(new Error(entry.deliveryError || receipt.lastError));
      track.append(error);
    }
    if (phase !== "finished") {
      const run = async (action, minutes) => {
        if (tidalModerationPending.has(entry.id)) return;
        tidalModerationPending.add(entry.id);
        actions.querySelectorAll("button").forEach((button) => {
          button.disabled = true;
        });
        try {
          await moderate(
            { action, entryId: entry.id, ...(minutes ? { minutes } : {}) },
            action === "block_song"
              ? "Song banned from future requests."
              : action === "timeout_song"
                ? "Song timed out."
                : "Request removed.",
          );
        } finally {
          tidalModerationPending.delete(entry.id);
          await refresh();
        }
      };
      actions.className = "rowActions";
      actions.append(
        actionButton(
          phase === "playing" ? "SKIP" : "REMOVE",
          "Remove this request from RaveLink and TIDAL",
          () => run("remove"),
        ),
      );
      const duration = songDuration(entry.id);
      const groups = [
        {
          title: "Song",
          description: entry.candidate?.title || receipt?.title,
          controls: [
            duration,
            actionButton(
              "TIMEOUT SONG",
              "Temporarily block this track and remove its requests",
              () => run("timeout_song", Number(duration.value)),
              true,
            ),
            actionButton(
              "BAN SONG",
              "Block this track and remove its queued requests",
              () => run("block_song"),
              true,
            ),
          ],
        },
      ];
      if (owner.requesterKey)
        groups.push({
          title: "Requester",
          description: owner.displayName,
          controls: [requesterActions(owner, true)],
        });
      actions.append(
        moderationControls(
          owner.requesterKey ? "Song and requester moderation" : "Song moderation",
          groups,
        ),
      );
    }
    if (phase === "finished" && owner.requesterKey) actions.append(requesterActions(owner));
    if (tidalModerationPending.has(entry.id))
      actions.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
      });
  }
  if (!body.rows.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 4;
    cell.className = "empty";
    cell.textContent = "NO TIDAL REQUESTS";
  }
}
