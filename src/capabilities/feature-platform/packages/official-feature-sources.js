const GITHUB_RAW_ROOT = "https://raw.githubusercontent.com/NameSRoby/RaveLink-Core/refs/heads/main/features/";

const OFFICIAL_FEATURE_SOURCES = Object.freeze([
  Object.freeze({
    id: "clip-studio",
    name: "Clip Studio",
    description: "Optional video indexing and explainable clip-candidate infrastructure. Analysis engines will arrive in later package updates.",
    baseUrl: `${GITHUB_RAW_ROOT}clip-studio/`,
    displaySource: "RaveLink GitHub repository"
  })
]);

module.exports = { GITHUB_RAW_ROOT, OFFICIAL_FEATURE_SOURCES };
