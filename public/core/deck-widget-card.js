/** Stable widget nodes keep artwork, progress and focus intact across updates. */
export const widgetNames = {
  "now-playing": "Now playing",
  queue: "Current requester",
  "next-request": "Next requested song",
  stream: "Stream timer",
  audience: "Audience",
  viewers: "Viewers",
  followers: "Followers",
  subscribers: "Subscribers",
  clips: "Recent clips",
  markers: "Timestamps",
  obs: "OBS status",
  rewards: "Channel Points",
  connections: "Connections",
  clock: "Clock",
};
const node = (tag, css) => {
  const n = document.createElement(tag);
  if (css) n.className = css;
  return n;
};
const text = (n, value) => {
  const next = String(value ?? "");
  if (n.textContent !== next) n.textContent = next;
};
export const duration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return (
    (s >= 3600 ? Math.floor(s / 3600) + ":" : "") +
    String(Math.floor(s / 60) % 60).padStart(2, "0") +
    ":" +
    String(s % 60).padStart(2, "0")
  );
};
const date = (ms, w) =>
  new Date(ms).toLocaleString(undefined, {
    ...(w.utc ? { timeZone: "UTC" } : {}),
    hour12: !w.clock24,
  });
export function createWidgetCard(widget, { mark, exportMoments, editing, openTwitch, openObs }) {
  const root = node("article", "deckWidget"),
    header = node("div", "deckWidgetHeading"),
    title = node("h3"),
    body = node("div", "deckWidgetBody"),
    art = node("img", "deckWidgetArtwork"),
    main = node("strong", "deckWidgetMain"),
    meta = node("p"),
    sub = node("p", "deckWidgetMuted"),
    progress = node("progress"),
    timing = node("small"),
    list = node("div", "deckWidgetList"),
    foot = node("small", "deckWidgetMuted");
  root.dataset.widgetId = widget.id;
  root.dataset.widgetType = widget.type;
  root.dataset.size = widget.size;
  root.dataset.surface = widget.surface;
  header.hidden = !widget.showTitle && !editing;
  root.style.setProperty("--widget-color", widget.color);
  text(title, widget.title || widgetNames[widget.type]);
  header.append(title);
  art.alt = "Album cover";
  art.hidden = true;
  progress.hidden = true;
  progress.setAttribute("aria-label", "Song progress");
  timing.hidden = true;
  const copy = node("div", "deckWidgetCopy");
  copy.append(main, meta, sub, progress, timing, list, foot);
  body.append(art, copy);
  root.append(header, body);
  let listKey = "";
  function rows(values) {
    const key = JSON.stringify(values);
    if (key === listKey) return;
    listKey = key;
    list.replaceChildren(
      ...values.map((row) => {
        const item = node(row.url ? "a" : "div", "deckWidgetListRow");
        text(item, row.text);
        if (
          row.url &&
          /^https:\/\/(?:clips\.twitch\.tv\/[A-Za-z0-9_-]+|www\.twitch\.tv\/videos\/\d+\?t=[0-9hms]+)$/.test(
            row.url,
          )
        ) {
          item.href = row.url;
          item.target = "_blank";
          item.rel = "noopener noreferrer";
        }
        return item;
      }),
    );
  }
  let markerButton, description, advanced, historyTitle;
  let setup;
  if (
    [
      "stream",
      "audience",
      "viewers",
      "followers",
      "subscribers",
      "clips",
      "connections",
      "obs",
    ].includes(widget.type)
  ) {
    setup = node("button", "deckWidgetSetup");
    setup.type = "button";
    text(setup, widget.type === "obs" ? "OBS connection" : "Twitch connection");
    setup.onclick = () => {
      if (widget.type === "obs") void openObs?.();
      else if (openTwitch?.() === false) text(foot, "Enable Twitch Integration in Packages first.");
    };
    root.append(setup);
  }
  if (widget.type === "markers") {
    const controls = node("div", "deckWidgetMomentTools");
    description = node("input");
    description.maxLength = 140;
    description.placeholder = "What happened? (optional)";
    description.setAttribute("aria-label", "Timestamp description");
    markerButton = node("button");
    markerButton.type = "button";
    text(markerButton, "+ Mark moment");
    advanced = node("details", "deckWidgetAdvanced");
    advanced.open = widget.details;
    historyTitle = node("summary");
    text(historyTitle, "Notes & history");
    historyTitle.title = "Add a note, review timestamps or export them.";
    advanced.append(historyTitle, description);
    advanced.ontoggle = () => {
      list.hidden = !widget.details && !advanced.open;
    };
    markerButton.onclick = () =>
      void mark(description.value, markerButton, () => {
        description.value = "";
        advanced.open = widget.details;
      });
    const download = node("button");
    download.type = "button";
    text(download, "Export");
    download.onclick = () => void exportMoments();
    advanced.append(download);
    controls.append(markerButton, advanced);
    root.append(controls);
  }
  return {
    root,
    header,
    update(data, now, connected = true) {
      const music = data.music || {},
        twitch = data.twitch || {},
        stream = twitch.stream,
        obs = data.obs || {};
      meta.hidden = sub.hidden = foot.hidden = false;
      progress.hidden = timing.hidden = art.hidden = true;
      text(meta, "");
      text(sub, "");
      text(foot, connected ? "" : "Status connection lost");
      let entries = [];
      if (["queue", "next-request"].includes(widget.type)) {
        const next = widget.type === "next-request",
          track = next ? music.next?.[0] : music.current;
        text(main, next ? track?.title || "No song" : track?.requester || "No requester");
        text(meta, widget.details ? (next ? track?.artists?.join(", ") : track?.title) || "" : "");
        text(
          sub,
          next && widget.requester && track?.requester ? "Requested by " + track.requester : "",
        );
        if (next && widget.artwork && track?.artwork) {
          art.hidden = false;
          if (art.getAttribute("src") !== track.artwork) art.src = track.artwork;
        }
        text(foot, music.available ? "" : "Enable Song Request");
      } else if (widget.type === "now-playing") {
        const current = music.current;
        text(main, current?.title || (music.available ? "Nothing playing" : "Enable Song Request"));
        text(meta, widget.details ? current?.artists?.join(", ") || "" : "");
        if (current && widget.artwork && current.artwork) {
          art.hidden = false;
          if (art.getAttribute("src") !== current.artwork) art.src = current.artwork;
        }
        if (current && widget.progress && current.durationMs > 0) {
          const elapsed =
              current.status === "playing" && connected ? Math.max(0, now - current.observedAt) : 0,
            position = Math.min(current.durationMs, current.positionMs + elapsed);
          progress.hidden = timing.hidden = false;
          progress.max = current.durationMs;
          progress.value = position;
          text(timing, duration(position) + " / " + duration(current.durationMs));
        }
        text(
          sub,
          widget.requester && current?.requester ? "Requested by " + current.requester : "",
        );
        text(
          foot,
          music.available
            ? [
                current?.status === "paused" ? "Paused" : current ? "Playing" : "",
                music.paused
                  ? "Requests paused"
                  : music.queued !== null
                    ? (music.queued || 0) + " queued"
                    : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : "Connect your player to show music and request details.",
        );
        if (widget.next) {
          const limit = 1;
          entries = (music.next || []).slice(0, limit).map((row, i) => ({
            text:
              (music.nativeQueueIncomplete ? "Queued: " : i ? "Then: " : "Next: ") +
              row.title +
              (widget.requester && row.requester ? " · " + row.requester : ""),
          }));
          if (music.nativeQueueIncomplete)
            entries.unshift({ text: "Next track: native player details unavailable." });
          entries = entries.slice(0, limit);
        }
        if (widget.size === "compact") {
          if (!widget.details)
            text(
              foot,
              current?.status === "paused" ? "Paused" : music.paused ? "Requests paused" : "",
            );
        }
      } else if (widget.type === "stream") {
        const live = stream?.ok && stream.live,
          obsLive = obs.connection?.connected && obs.streaming,
          started = live ? stream.startedAt : obsLive ? obs.streamTiming?.startedAt : null;
        text(
          main,
          started
            ? "Live · " + duration(now - started)
            : stream?.ok
              ? "Offline"
              : obsLive
                ? "OBS output live"
                : "Stream status unavailable",
        );
        text(
          meta,
          started
            ? widget.size === "compact"
              ? "Started " +
                new Date(started).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: !widget.clock24,
                  ...(widget.utc ? { timeZone: "UTC" } : {}),
                })
              : widget.details
                ? "Started " + date(started, widget)
                : ""
            : "",
        );
        text(
          sub,
          widget.details && live ? [stream.title, stream.category].filter(Boolean).join(" · ") : "",
        );
        text(
          foot,
          live && stream.viewers !== null
            ? stream.viewers + " watching"
            : obsLive
              ? "OBS elapsed time"
              : twitch.connected
                ? "Twitch"
                : "Connect Twitch or OBS",
        );
        if (widget.size === "compact" && !widget.details) text(foot, "");
      } else if (["viewers", "followers", "subscribers"].includes(widget.type)) {
        const value =
          widget.type === "viewers"
            ? stream?.ok && stream.live
              ? stream.viewers
              : null
            : twitch[widget.type]?.ok
              ? twitch[widget.type].total
              : null;
        text(
          main,
          value !== null && value !== undefined
            ? value.toLocaleString() +
                (widget.size === "compact"
                  ? " " + (widget.type === "viewers" ? "watching" : widget.type)
                  : "")
            : twitch.connected
              ? widgetNames[widget.type] + " unavailable"
              : "Connect Twitch",
        );
        if (
          widget.type === "subscribers" &&
          twitch.subscribers?.error === "twitch_subscriber_scope_required"
        )
          text(meta, "Grant subscriber access in Twitch Connection.");
        else if (widget.type === "subscribers" && widget.details && twitch.subscribers?.ok)
          text(meta, "Sub points: " + twitch.subscribers.points);
        if (widget.type === "followers" && widget.details)
          entries = (twitch.followers?.recent || [])
            .slice(0, widget.rows)
            .map((row) => ({ text: row.name }));
        text(foot, widget.details ? "Updated periodically from Twitch." : "");
      } else if (widget.type === "audience") {
        text(main, twitch.connected ? "Audience" : "Connect Twitch");
        if (twitch.connected) {
          entries = [
            {
              text:
                "Viewers: " +
                (stream?.ok && stream.live && stream.viewers !== null ? stream.viewers : "—"),
            },
            {
              text:
                "Followers: " +
                (twitch.followers?.ok && twitch.followers.total !== null
                  ? twitch.followers.total
                  : "Unavailable"),
            },
            {
              text:
                "Subscribers: " +
                (twitch.subscribers?.ok && twitch.subscribers.total !== null
                  ? twitch.subscribers.total
                  : twitch.subscribers?.error === "twitch_subscriber_scope_required"
                    ? "Grant subscriber access"
                    : "Unavailable"),
            },
          ];
          if (widget.details && twitch.subscribers?.points !== null && twitch.subscribers?.ok)
            entries.push({ text: "Sub points: " + twitch.subscribers.points });
          if (widget.details)
            entries.push(
              ...(twitch.followers?.recent || [])
                .slice(0, widget.rows)
                .map((row) => ({ text: "Followed: " + row.name })),
            );
        }
        text(foot, "Totals refresh periodically; optional access is chosen in Twitch Connection.");
        if (widget.size === "compact" && twitch.connected) {
          const viewers = stream?.ok && stream.live ? stream.viewers : null,
            followers = twitch.followers?.ok ? twitch.followers.total : null,
            subs = twitch.subscribers?.ok ? twitch.subscribers.total : null;
          text(
            main,
            (viewers ?? "—") +
              " watching · " +
              (followers ?? "—") +
              " followers · " +
              (subs ?? "—") +
              " subs",
          );
          if (!widget.details) entries = [];
        }
        if (!widget.details) text(foot, "");
      } else if (widget.type === "clips") {
        const clips = twitch.clips;
        text(
          main,
          clips?.ok
            ? clips.count + (clips.complete ? "" : "+") + " clips"
            : "Connect Twitch to show clips",
        );
        text(
          meta,
          stream?.ok && stream.live ? "Created since go-live" : "Created in the last 24 hours",
        );
        entries = (clips?.recent || []).slice(0, widget.rows).map((row) => ({
          text: row.title + (widget.details && row.creator ? " · " + row.creator : ""),
          url: row.url,
        }));
        if (clips && !clips.ok) text(foot, "Clip information is temporarily unavailable.");
        if (widget.size === "compact" && !widget.details) {
          text(meta, "");
          text(foot, "");
        }
      } else if (widget.type === "markers") {
        const last = data.timestamps?.[0];
        text(
          main,
          widget.size === "compact"
            ? last
              ? "\u2691 " + duration(last.positionSeconds * 1000) + " · " + last.description
              : "Stream moments"
            : (data.timestampCount ?? data.timestamps?.length ?? 0) + " moments marked",
        );
        entries = (data.timestamps || []).slice(0, widget.rows).map((row) => ({
          text:
            duration(row.positionSeconds * 1000) +
            " · " +
            row.description +
            (widget.details && row.song ? " · " + row.song : ""),
          url: row.url,
        }));
        text(
          foot,
          data.canTimestamp
            ? "Mark the current stream time. VOD links appear when available."
            : "Go live through Twitch or OBS to mark a moment.",
        );
        markerButton.disabled =
          editing || !connected || !data.canTimestamp || markerButton.dataset.pending === "true";
        text(historyTitle, "Notes & history (" + (data.timestampCount ?? 0) + ")");
        list.hidden = !widget.details && !advanced.open;
        if (widget.size === "compact" && !widget.details)
          text(foot, data.canTimestamp ? "" : "Stream offline");
      } else if (widget.type === "obs") {
        text(main, obs.connection?.connected ? obs.program || "OBS connected" : "Connect OBS");
        text(
          meta,
          widget.details && obs.connection?.connected
            ? [
                obs.streaming ? "Streaming" : "Not streaming",
                obs.recording ? "Recording" : "Not recording",
                obs.studio ? "Studio Mode" : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : "",
        );
        if (widget.details && obs.stats)
          text(sub, obs.stats.fps.toFixed(1) + " FPS · OBS CPU " + obs.stats.cpu.toFixed(1) + "%");
        if (widget.details && obs.streamTiming)
          text(
            foot,
            (obs.streamTiming.dropped || 0) +
              " skipped / " +
              (obs.streamTiming.frames || 0) +
              " output frames",
          );
        if (widget.size === "compact" && obs.connection?.connected) {
          text(main, "OBS · " + (obs.program || "Connected"));
          text(
            meta,
            [
              obs.streaming ? "Live" : "",
              obs.recording ? "Recording" : "",
              obs.studio ? "Studio" : "",
            ]
              .filter(Boolean)
              .join(" · ") || "Ready",
          );
        }
      } else if (widget.type === "rewards") {
        const rewards = data.rewards?.rows || [],
          known = data.rewards?.available && rewards.every((r) => typeof r.paused === "boolean");
        text(
          main,
          known
            ? rewards.filter((r) => !r.paused && r.enabled !== false).length +
                " / " +
                rewards.length +
                " rewards active"
            : "Connect Twitch rewards",
        );
        if (widget.details)
          entries = rewards.slice(0, widget.rows).map((r) => ({
            text:
              r.title + " · " + (r.enabled === false ? "Disabled" : r.paused ? "Paused" : "Active"),
          }));
      } else if (widget.type === "connections") {
        text(main, connected ? "Connections" : "Connection lost");
        entries = [
          { text: "OBS · " + (obs.connection?.connected ? "Connected" : "Disconnected") },
          { text: "Twitch · " + (twitch.connected ? "Connected" : "Disconnected") },
        ];
      } else if (widget.type === "clock") {
        text(
          main,
          new Date(now).toLocaleTimeString(undefined, {
            hour12: !widget.clock24,
            ...(widget.utc ? { timeZone: "UTC" } : {}),
          }),
        );
        text(
          meta,
          widget.details
            ? new Date(now).toLocaleDateString(undefined, {
                dateStyle: "full",
                ...(widget.utc ? { timeZone: "UTC" } : {}),
              })
            : "",
        );
        text(foot, widget.utc ? "UTC" : "Local time");
        if (widget.size === "compact" && !widget.details) text(foot, widget.utc ? "UTC" : "");
      }
      rows(entries);
      meta.hidden = !meta.textContent;
      sub.hidden = !sub.textContent;
      foot.hidden = !foot.textContent;
      main.title = main.textContent;
      if (setup)
        setup.hidden =
          widget.type === "obs"
            ? !!obs.connection?.connected
            : twitch.connected &&
              !(
                ["audience", "subscribers"].includes(widget.type) &&
                twitch.subscribers?.error === "twitch_subscriber_scope_required"
              );
      if (setup) setup.disabled = editing;
    },
  };
}
