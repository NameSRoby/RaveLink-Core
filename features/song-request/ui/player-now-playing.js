/**
 * Now-playing metadata and artwork presentation.
 * Keep the selected provider's observed identity with the display state. A title
 * and thumbnail can update independently, so refresh a corrected cover even for
 * the same song. A failed image should not preserve the preceding song's artwork.
 * Reuse the existing card rather than rebuilding it on every progress tick.
 */
/* exported installNowPlayingDetails */
function installNowPlayingDetails() {
  const card = document.querySelector(".now");
  card.classList.add("nowPlayingCard");
  const details = $("nowTitle").parentElement;
  details.classList.add("nowDetails");
  const caption = document.createElement("div");
  caption.className = "nowCaption";
  caption.textContent = "NOW PLAYING";
  details.prepend(caption);
  const cover = document.createElement("div");
  cover.className = "nowCover";
  cover.innerHTML =
    '<span aria-hidden="true">♪</span><img id="nowArtwork" alt="" decoding="async" referrerpolicy="no-referrer" hidden>';
  card.prepend(cover);
  const album = document.createElement("div");
  album.id = "nowAlbum";
  album.className = "nowAlbum";
  album.hidden = true;
  details.append(album);
  const facts = document.createElement("div");
  facts.className = "nowFacts";
  const status = document.createElement("span");
  status.id = "nowPlaybackState";
  facts.append(status, $("nowProvider"));
  details.append(facts);
  const timeline = document.createElement("div");
  timeline.id = "nowTimeline";
  timeline.hidden = true;
  timeline.innerHTML =
    '<progress id="nowProgress" max="1" value="0" aria-label="Playback progress"></progress><div class="nowTimes"><span id="nowElapsed"></span><span id="nowDuration"></span></div>';
  details.append(timeline);
  let playback = null,
    imageUrl = "",
    imageFailed = false;
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000)),
      hours = Math.floor(seconds / 3600);
    return (
      (hours
        ? hours + ":" + String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")
        : Math.floor(seconds / 60)) +
      ":" +
      String(seconds % 60).padStart(2, "0")
    );
  };
  const image = $("nowArtwork");
  image.onload = () => {
    if (image.getAttribute("src") === imageUrl && !imageFailed) {
      image.hidden = false;
      cover.classList.add("hasArtwork");
    }
  };
  image.onerror = () => {
    imageFailed = true;
    image.hidden = true;
    cover.classList.remove("hasArtwork");
  };
  function tick() {
    if (!playback) return;
    const duration = Math.max(
      0,
      Number(playback.durationMs || playback.candidate?.durationMs) || 0,
    );
    let elapsed =
      Math.max(0, Number(playback.positionMs) || 0) +
      (playback.status === "playing"
        ? Math.max(0, Date.now() - Number(playback.observedAt || Date.now()))
        : 0);
    if (
      playback.candidate?.provider === "youtube" &&
      playerReady &&
      typeof player?.getCurrentTime === "function"
    )
      elapsed = Math.max(0, Number(player.getCurrentTime()) * 1000 || 0);
    timeline.hidden = !duration;
    $("nowProgress").value = duration ? Math.min(1, elapsed / duration) : 0;
    $("nowElapsed").textContent = clock(Math.min(elapsed, duration || elapsed));
    $("nowDuration").textContent = clock(duration);
  }
  const timer = setInterval(tick, 1000);
  window.addEventListener("pagehide", () => clearInterval(timer));
  return function render(current) {
    playback = current;
    const track = current?.candidate || current;
    const nextUrl = String(track?.artworkUrl || "");
    if (nextUrl !== imageUrl) {
      imageUrl = nextUrl;
      imageFailed = false;
      image.hidden = true;
      cover.classList.remove("hasArtwork");
      if (nextUrl) image.src = nextUrl;
      else image.removeAttribute("src");
    }
    image.alt = track?.album
      ? "Cover for " + track.album
      : track?.title
        ? "Artwork for " + track.title
        : "";
    album.textContent = track?.album || "";
    album.hidden = !track?.album;
    status.textContent = current
      ? {
          playing: "Playing",
          paused: "Paused",
          loading: "Loading",
          stopped: "Stopped",
        }[current.status] || "Ready"
      : "Nothing playing";
    status.dataset.state = current?.status || "stopped";
    caption.textContent =
      current?.origin === "playlist"
        ? "SERVER PLAYLIST"
        : current?.origin === "queue"
          ? "REQUESTED TRACK"
          : "NOW PLAYING";
    timeline.hidden = !current;
    tick();
  };
}
