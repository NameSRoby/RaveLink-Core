// A release must download every manifest and payload from one immutable tree.
// A moving branch can be cached per file by GitHub and briefly mix revisions.
const OFFICIAL_FEATURE_REVISION = "718693009c1af0052a4bcec79afa6fbb549cdc23";
const GITHUB_RAW_ROOT = `https://raw.githubusercontent.com/NameSRoby/RaveLink-Core/${OFFICIAL_FEATURE_REVISION}/features/`;

const OFFICIAL_FEATURE_SOURCES = Object.freeze([
  Object.freeze({
    id: "automation",
    name: "Alerts / TTS",
    description: "Lighting animations, Twitch triggers, donation moderation, local stream-alert surfaces, and optional speech setup.",
    baseUrl: `${GITHUB_RAW_ROOT}automation/`,
    displaySource: "RaveLink GitHub repository"
  }),
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
    description: "YouTube song requests, playlists, moderation, embedded playback, and OBS now-playing surfaces.",
    baseUrl: `${GITHUB_RAW_ROOT}song-request/`,
    displaySource: "RaveLink GitHub repository"
  }),
  Object.freeze({
    id: "tts-engine-local",
    name: "Local TTS Engine",
    description: "Isolated local speech runtime foundation. Voice and synthesis payloads install separately after review.",
    baseUrl: `${GITHUB_RAW_ROOT}tts-engine-local/`,
    displaySource: "RaveLink GitHub repository"
  }),
  Object.freeze({
    id: "twitch-integration",
    name: "Twitch Integration",
    description: "Twitch OAuth, EventSub, Channel Points rewards, chat responses, and redemption settlement.",
    baseUrl: `${GITHUB_RAW_ROOT}twitch-integration/`,
    displaySource: "RaveLink GitHub repository"
  })
]);

module.exports = { GITHUB_RAW_ROOT, OFFICIAL_FEATURE_REVISION, OFFICIAL_FEATURE_SOURCES };
