// A release must download every manifest and payload from one immutable tree.
// A moving branch can be cached per file by GitHub and briefly mix revisions.
const OFFICIAL_FEATURE_REVISION = "44a68e36c807eb9aa92f64b62e705ac738777134";
const GITHUB_RAW_ROOT = `https://raw.githubusercontent.com/NameSRoby/RaveLink-Core/${OFFICIAL_FEATURE_REVISION}/features/`;

const OFFICIAL_FEATURE_SOURCES = Object.freeze([
  Object.freeze({
    id: "clip-studio",
    name: "Clip Studio",
    description: "Optional video indexing and explainable clip-candidate infrastructure. Analysis engines will arrive in later package updates.",
    baseUrl: `${GITHUB_RAW_ROOT}clip-studio/`,
    displaySource: "RaveLink GitHub repository"
  }),
  Object.freeze({
    id: "song-request",
    name: "Song Request",
    description: "YouTube, Spotify, TIDAL and SoundCloud requests, community playlists, reviewed transfers, moderation and OBS overlays.",
    baseUrl: `${GITHUB_RAW_ROOT}song-request/`,
    displaySource: "RaveLink GitHub repository"
  }),
  Object.freeze({
    id: "twitch-integration",
    minimumVersion: "0.12.0",
    name: "Twitch Integration",
    description: "Twitch OAuth, EventSub, Channel Points rewards, chat responses, and redemption settlement.",
    baseUrl: `${GITHUB_RAW_ROOT}twitch-integration/`,
    displaySource: "RaveLink GitHub repository"
  })
]);

module.exports = { GITHUB_RAW_ROOT, OFFICIAL_FEATURE_REVISION, OFFICIAL_FEATURE_SOURCES };
