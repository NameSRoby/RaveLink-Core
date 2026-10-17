/**
 * Player artwork.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
function observed(value) {
  return typeof value === "string" &&
    value.length <= 12288 &&
    /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value)
    ? value
    : "";
}
function soundcloud(value) {
  if (typeof value !== "string" || value.length > 500) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "i1.sndcdn.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(url.pathname)
      ? url.href
      : "";
  } catch {
    return "";
  }
}
function spotify(value) {
  return typeof value === "string" && /^https:\/\/i\.scdn\.co\/image\/[a-f0-9]{40}$/i.test(value)
    ? value
    : "";
}
module.exports = { observed, soundcloud, spotify };
