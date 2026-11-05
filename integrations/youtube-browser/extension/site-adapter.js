/**
 * DOM fallback for observations and manual playback controls when the primary
 * native-service adapter is unavailable. This module never calls private APIs.
 * Keep fallback selectors here; internal service roots live in native-service.js.
 * A rendered queue is only a partial observation, never an occurrence ledger.
 */
(() => {
  const clean = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  function videoId(href) {
    try {
      const url = new URL(href, "https://music.youtube.com");
      const id = url.searchParams.get("v");
      return url.origin === "https://music.youtube.com" && /^[A-Za-z0-9_-]{11}$/.test(id || "")
        ? id
        : null;
    } catch {
      return null;
    }
  }
  function create(document, location) {
    const bar = () => document.querySelector("ytmusic-player-bar");
    const media = () => document.querySelector("ytmusic-player video, #movie_player video");
    const next = () => bar()?.querySelector(".next-button, #next-button");
    function artistText(container) {
      const byline = container?.querySelector(".byline");
      const artists = Array.from(
        byline?.querySelectorAll('a[href*="/channel/"], a[href*="/browse/UC"]') || [],
      )
        .map((node) => clean(node.textContent))
        .filter(Boolean);
      // Video mode includes view/like counts; song mode can include album/year.
      // Prefer artist links, otherwise retain only the first byline component.
      return artists.length
        ? clean(artists.join(", "))
        : clean(byline?.textContent)
            .split(/[\u2022\u00b7]/)[0]
            .trim();
    }
    function read() {
      const playerBar = bar(),
        video = media();
      const titleNode = playerBar?.querySelector(".title");
      const id = videoId(
        titleNode?.closest("a")?.href || titleNode?.querySelector("a")?.href || location.href,
      );
      const artist = artistText(playerBar);
      const current =
        id && titleNode ? { videoId: id, title: clean(titleNode.textContent), artist } : null;
      const rows = document.querySelectorAll(
        "ytmusic-player-queue-item, ytmusic-player-queue-item-renderer",
      );
      const queue = Array.from(rows)
        .slice(0, 100)
        .map((row) => {
          const link = row.querySelector('a[href*="watch?"]');
          const rowId = videoId(link?.href);
          const title = clean(
            row.querySelector(".song-title, #song-title")?.textContent || link?.textContent,
          );
          return title || rowId
            ? {
                videoId: rowId,
                title,
                artist: artistText(row),
                identityAvailable: Boolean(rowId),
              }
            : null;
        })
        .filter(Boolean);
      const button = next();
      return {
        current,
        mediaReady: Boolean(video && video.readyState >= 1),
        paused: video?.paused !== false,
        position: video?.currentTime || 0,
        duration: Number.isFinite(video?.duration) ? video.duration : 0,
        volume: video ? Math.round(video.volume * 100) : 0,
        ad: Boolean(document.querySelector("#movie_player.ad-showing, ytmusic-player.ad-showing")),
        nextAvailable: Boolean(
          button && !button.disabled && button.getAttribute("aria-disabled") !== "true",
        ),
        queue,
        queueComplete: false,
      };
    }
    async function execute(command) {
      const before = read(),
        video = media();
      if (!before.current || !before.mediaReady || !video)
        return { ok: false, error: "player_unavailable" };
      if (before.current.videoId !== command.expectedVideoId)
        return { ok: false, error: "player_changed" };
      if (before.ad) return { ok: false, error: "unsupported_control" };
      if (command.action === "volume") {
        if (!Number.isInteger(command.value) || command.value < 0 || command.value > 100)
          return { ok: false, error: "unsupported_control" };
        video.volume = command.value / 100;
      } else if (command.action === "pause") video.pause();
      else if (command.action === "resume") {
        try {
          await video.play();
        } catch {
          return { ok: false, error: "autoplay_blocked" };
        }
      } else if (command.action === "skip" && before.nextAvailable) next().click();
      else return { ok: false, error: "unsupported_control" };
      // Dispatch is not success. Observe the requested state, with a bounded wait.
      // Identical adjacent video IDs cannot prove a skip and remain unconfirmed.
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = read();
        const same = state.current?.videoId === before.current.videoId;
        if (
          (command.action === "skip" && state.current && !same) ||
          (same &&
            ((command.action === "pause" && state.paused) ||
              (command.action === "resume" && !state.paused) ||
              (command.action === "volume" && state.volume === command.value)))
        )
          return { ok: true };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: false, error: "control_unconfirmed" };
    }
    return { read, execute };
  }
  globalThis.RaveLinkYouTubeSite = Object.freeze({ create });
})();
