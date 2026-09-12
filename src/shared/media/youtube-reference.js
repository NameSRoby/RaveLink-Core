const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com", "youtu.be"]);

function youtubeVideoId(value) {
  const query = String(value || "").trim();
  if (YOUTUBE_ID_RE.test(query)) return query;
  let url;
  try { url = new URL(query); } catch { return ""; }
  if (url.protocol !== "https:" || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return "";
  const segments = url.pathname.split("/").filter(Boolean);
  const candidate = url.hostname.toLowerCase() === "youtu.be"
    ? segments[0]
    : url.searchParams.get("v") || (["shorts", "embed", "live"].includes(segments[0]) ? segments[1] : "");
  return YOUTUBE_ID_RE.test(String(candidate || "")) ? candidate : "";
}

module.exports = { YOUTUBE_HOSTS, YOUTUBE_ID_RE, youtubeVideoId };
