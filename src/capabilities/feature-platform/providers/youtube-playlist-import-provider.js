const crypto = require("node:crypto");

const JOB_TTL_MS = 15 * 60 * 1000;

function text(value, maximum) {
  return String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function playlistIdFrom(value) {
  const input = text(value, 500);
  if (/^(?:PL|UU|OLAK5uy_|RD|FL)[A-Za-z0-9_-]{8,}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com", "music.youtube.com"].includes(url.hostname)) return "";
    const id = text(url.searchParams.get("list"), 80);
    return /^(?:PL|UU|OLAK5uy_|RD|FL)[A-Za-z0-9_-]{8,}$/.test(id) ? id : "";
  } catch { return ""; }
}

function createYoutubePlaylistImportProvider(options = {}) {
  const keyless = options.keyless;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const jobs = new Map();

  function trim() {
    const cutoff = Number(now()) - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.updatedAt < cutoff && job.state !== "running") jobs.delete(id);
  }

  function start(input = {}) {
    trim();
    const playlistId = playlistIdFrom(input.url || input.playlistId);
    if (!playlistId) {
      const raw = text(input.url || input.playlistId, 500);
      if (/^https:\/\/(?:open\.)?spotify\.com\/playlist\//i.test(raw)) return { ok: false, error: "spotify_playlist_oauth_required" };
      return { ok: false, error: "youtube_playlist_url_invalid" };
    }
    if ([...jobs.values()].some(job => job.state === "running")) return { ok: false, error: "playlist_import_busy" };
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    const job = { id: jobId, state: "running", playlistId, title: "", items: [], count: 0, truncated: false, error: "", createdAt: Number(now()), updatedAt: Number(now()), controller };
    jobs.set(jobId, job);
    Promise.resolve(keyless.importPlaylist({ playlistId, limit: Math.min(2500, Math.max(1, Number(input.limit) || 2500)), signal: controller.signal }))
      .then(result => {
        if (job.state === "canceled") return;
        job.updatedAt = Number(now());
        if (!result?.ok) { job.state = "failed"; job.error = text(result?.reason || "youtube_playlist_unavailable", 120); return; }
        job.state = "complete";
        job.title = text(result.playlist?.title, 120) || playlistId;
        job.items = Array.isArray(result.items) ? result.items.slice(0, 2500) : [];
        job.count = job.items.length;
        job.truncated = result.truncated === true;
      })
      .catch(error => { job.state = "failed"; job.error = text(error?.message || "youtube_playlist_unavailable", 120); job.updatedAt = Number(now()); });
    return { ok: true, jobId, state: job.state, playlistId };
  }

  function status(input = {}) {
    trim();
    const job = jobs.get(text(input.jobId, 80));
    return job
      ? { ok: true, jobId: job.id, state: job.state, playlistId: job.playlistId, title: job.title, count: job.count, truncated: job.truncated, error: job.error }
      : { ok: false, error: "playlist_import_not_found" };
  }

  function page(input = {}) {
    const job = jobs.get(text(input.jobId, 80));
    if (!job) return { ok: false, error: "playlist_import_not_found" };
    if (job.state !== "complete") return { ok: false, error: "playlist_import_not_complete" };
    const offset = Math.max(0, Math.min(job.items.length, Number(input.offset) || 0));
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 100));
    return { ok: true, items: job.items.slice(offset, offset + limit), offset, total: job.items.length, hasMore: offset + limit < job.items.length };
  }

  function cancel(input = {}) {
    const job = jobs.get(text(input.jobId, 80));
    if (!job) return { ok: false, error: "playlist_import_not_found" };
    if (job.state === "running") job.controller.abort();
    job.state = "canceled";
    job.updatedAt = Number(now());
    job.items = [];
    return { ok: true, jobId: job.id, state: job.state };
  }

  return Object.freeze({ cancel, page, start, status });
}

module.exports = { createYoutubePlaylistImportProvider, playlistIdFrom };
