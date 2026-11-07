/** Local bookmarks are independent of Twitch write permission. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const fault = (code) => Object.assign(Error(code), { code });
const text = (v, n) =>
  String(v || "")
    .replace(/[\x00-\x1f]/g, " ")
    .trim()
    .slice(0, n);
module.exports = function timestamps({
  runtimeDir,
  getStream,
  getObs,
  getMedia,
  getProvider,
  refresh,
  notify,
  now = Date.now,
}) {
  const file = path.join(runtimeDir, "system", "stream-timestamps.json");
  let rows = [],
    pending = false,
    after = 0,
    last = null,
    closed = false;
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 1048576) throw Error();
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(value) && value.length <= 1000)
      rows = value.filter(
        (r) =>
          /^[a-f0-9]{24}$/.test(r.id) &&
          Number.isFinite(r.at) &&
          Number.isInteger(r.positionSeconds) &&
          r.positionSeconds >= 0 &&
          typeof r.description === "string" &&
          r.description.length <= 140,
      );
  } catch {}
  function source(at = now()) {
    const live = getStream();
    if (live?.ok && live.live && live.startedAt && live.startedAt <= at)
      return {
        source: "twitch",
        streamId: live.id,
        startedAt: live.startedAt,
        positionSeconds: Math.max(0, Math.floor((at - live.startedAt) / 1000)),
        videoId: live.videoId || null,
      };
    const obs = getObs();
    if (
      obs?.connection?.connected &&
      obs.streaming &&
      obs.streamTiming?.observedAt &&
      obs.streamTiming.startedAt <= at
    )
      return {
        source: "obs",
        streamId: null,
        startedAt: obs.streamTiming.startedAt,
        positionSeconds: Math.max(
          0,
          Math.floor((obs.streamTiming.durationMs + at - obs.streamTiming.observedAt) / 1000),
        ),
        videoId: null,
      };
    return null;
  }
  function link(row) {
    const stream = getStream(),
      videoId =
        row.videoId || (row.streamId && stream?.id === row.streamId ? stream.videoId : null);
    const seconds = row.positionSeconds;
    return {
      ...row,
      url:
        videoId && /^\d{1,80}$/.test(videoId)
          ? "https://www.twitch.tv/videos/" +
            videoId +
            "?t=" +
            Math.floor(seconds / 3600) +
            "h" +
            (Math.floor(seconds / 60) % 60) +
            "m" +
            (seconds % 60) +
            "s"
          : null,
    };
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(rows) + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  async function create(input = {}, remote = false, signal) {
    if (closed) throw fault("stream_timestamp_unavailable");
    if (
      Object.keys(input).some((k) => k !== "description") ||
      (input.description !== undefined &&
        (typeof input.description !== "string" || input.description.length > 140))
    )
      throw fault("stream_timestamp_invalid");
    if (pending || now() < after) throw fault("stream_timestamp_busy");
    pending = true;
    const pressedAt = now();
    try {
      await refresh();
      if (closed || signal?.aborted) throw fault("control_deck_cancelled");
      const current = source(pressedAt);
      if (!current) throw fault("stream_not_live");
      const description = text(input.description || "Highlight", 140);
      let confirmation = null;
      if (remote) {
        const provider = getProvider();
        if (!provider) throw fault("twitch_not_connected");
        const result = await provider.createStreamMarker({ description });
        if (!result.ok) throw fault(result.error || "twitch_marker_not_confirmed");
        confirmation = result;
      }
      if (closed) throw fault("control_deck_cancelled");
      const media = getMedia(),
        obs = getObs();
      const row = {
        id: crypto.randomBytes(12).toString("hex"),
        at: confirmation?.createdAt || pressedAt,
        ...current,
        positionSeconds: confirmation?.positionSeconds ?? current.positionSeconds,
        description,
        twitchMarkerId: confirmation?.id || null,
        song: text(media?.current?.title, 200),
        scene: text(obs?.program, 256),
      };
      const next = [row, ...rows].slice(0, 1000),
        before = rows;
      rows = next;
      try {
        save();
      } catch (e) {
        rows = before;
        throw e;
      }
      after = now() + 1500;
      last = { at: now(), positionSeconds: row.positionSeconds, remote };
      notify();
      return { ok: true, bookmark: link(row) };
    } finally {
      pending = false;
    }
  }
  return {
    create,
    source,
    close() {
      closed = true;
    },
    count: () => rows.length,
    pendingStreamIds: () =>
      [...new Set(rows.filter((r) => r.streamId && !r.videoId).map((r) => r.streamId))].slice(
        0,
        10,
      ),
    associate(videos) {
      let changed = false;
      for (const row of rows) {
        const match = videos.find((v) => v.streamId === row.streamId);
        if (!row.videoId && match) {
          row.videoId = match.videoId;
          changed = true;
        }
      }
      if (changed) {
        save();
        notify();
      }
    },
    latest: () => last,
    list: (limit = 10) => rows.slice(0, Math.min(1000, limit)).map(link),
    remove(id) {
      if (!rows.some((row) => row.id === id)) throw fault("stream_timestamp_missing");
      rows = rows.filter((row) => row.id !== id);
      save();
      notify();
      return { ok: true };
    },
  };
};
