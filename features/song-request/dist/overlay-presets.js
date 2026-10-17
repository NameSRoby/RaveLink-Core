/**
 * Overlay presets.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const { DEFAULT_OVERLAY, overlayFrom } = require("./overlay-config");
const section = (id, kinds, extra = {}) => ({
  id,
  enabled: true,
  direction: "column",
  align: "left",
  size: "wide",
  ...extra,
  blocks: kinds.map((kind) => ({
    id: id + "-" + kind,
    kind,
    ...(kind === "queue" ? { count: 3 } : {}),
  })),
});
/** Pixel-defined presets keep the progress bar and countdown on the same row.
 * Every block belongs to one segment, so one corner resizes the entire card.
 * These use the ordinary saved canvas model, with no preset-only renderer path.
 */
const canvasCard = (width, height, blocks) => ({
  layoutMode: "canvas",
  autoHeight: false,
  width,
  height,
  radius: 10,
  padding: 0,
  accentWidth: 0,
  opacity: 94,
  shadow: 30,
  colorFade: true,
  surfaceEffect: "glass",
  segments: [
    {
      ...section("card", []),
      name: "Track card",
      shape: "rounded",
      frame: { x: 0, y: 0, width, height },
      blocks: blocks.map(([kind, x, y, width, height]) => ({
        id: "card-" + kind,
        kind,
        frame: { x, y, width, height },
        style: { size: kind === "title" ? "large" : kind === "artists" ? "medium" : "inherit" },
      })),
    },
  ],
});
const entries = [
  ["classic", "Classic", "The original compact now-playing card.", {}],
  [
    "album-card",
    "Album card",
    "A compact frosted sleeve with readable song details and progress.",
    {
      skin: "glass",
      width: 420,
      radius: 22,
      padding: 12,
      gap: 12,
      accentWidth: 0,
      opacity: 65,
      artworkSize: 88,
      flow: "row",
      segments: [
        section("cover", ["artwork"], { size: "compact" }),
        section("track", ["label", "title", "artists", "progress", "meta"]),
      ],
    },
  ],
  [
    "minimal",
    "Minimal",
    "An understated type-led overlay with clear playback progress.",
    {
      skin: "minimal",
      width: 440,
      font: "system",
      titleMode: "scroll",
      opacity: 0,
      accentWidth: 0,
      shadow: 35,
      segments: [section("track", ["title", "artists", "progress"])],
    },
  ],
  [
    "split-panels",
    "Split panels",
    "Song and progress on one panel, artist on the other.",
    {
      skin: "duo",
      width: 440,
      flow: "grid",
      separated: true,
      radius: 6,
      padding: 10,
      gap: 6,
      blockGap: 3,
      accentWidth: 0,
      opacity: 88,
      segments: [section("track", ["title", "progress"]), section("artist", ["artists"])],
    },
  ],
  [
    "ribbon",
    "Compact strip",
    "A slim cover, song and progress strip for tight scenes.",
    {
      skin: "glass",
      width: 460,
      flow: "row",
      radius: 8,
      padding: 10,
      gap: 10,
      accentWidth: 0,
      artworkSize: 48,
      blockGap: 3,
      segments: [
        section("cover", ["artwork"], { size: "compact" }),
        section("track", ["title", "artists", "progress"]),
      ],
    },
  ],
  [
    "broadcast",
    "Provider badge",
    "A small provider-colored card. The accent follows the service.",
    {
      skin: "classic",
      width: 300,
      providerColors: true,
      accentPosition: "top",
      accentWidth: 3,
      padding: 10,
      radius: 6,
      blockGap: 3,
      segments: [section("track", ["provider", "title", "artists", "progress"])],
    },
  ],
  [
    "spotlight",
    "Cover chip",
    "Just cover, song and artist on a transparent background, for an unobtrusive corner label.",
    {
      skin: "minimal",
      width: 300,
      flow: "row",
      artworkSize: 44,
      radius: 4,
      padding: 4,
      gap: 8,
      opacity: 0,
      accentWidth: 0,
      blockGap: 3,
      segments: [
        section("cover", ["artwork"], { size: "compact" }),
        section("track", ["title", "artists"]),
      ],
    },
  ],
  [
    "compact-countdown",
    "Compact countdown",
    "Artwork, song and artist in a small card; remaining time sits beside progress.",
    canvasCard(340, 72, [
      ["artwork", 8, 10, 52, 52],
      ["title", 68, 8, 264, 26],
      ["artists", 68, 32, 264, 20],
      ["progress", 68, 57, 208, 7],
      ["remaining", 282, 51, 50, 18],
    ]),
  ],
  [
    "lower-third",
    "Lower third",
    "A wide, readable music banner for a scene footer: cover, title, artist and countdown.",
    canvasCard(560, 96, [
      ["artwork", 12, 12, 72, 72],
      ["title", 100, 12, 448, 30],
      ["artists", 100, 44, 448, 22],
      ["progress", 100, 78, 384, 7],
      ["remaining", 492, 72, 56, 18],
    ]),
  ],
  [
    "two-column",
    "Track + next",
    "A compact song card with a separate upcoming-track strip.",
    {
      skin: "classic",
      width: 360,
      flow: "column",
      separated: true,
      radius: 6,
      padding: 10,
      gap: 5,
      accentWidth: 2,
      blockGap: 3,
      segments: [
        section("track", ["title", "artists", "progress"]),
        section("next", ["queue"], { size: "full" }),
      ],
    },
  ],
];
const presets = entries.map(([id, name, description, extra]) => ({
  id,
  name,
  description,
  config: overlayFrom({ ...DEFAULT_OVERLAY, ...extra, preset: id }),
}));
module.exports = {
  list: () => presets.map(({ id, name, description }) => ({ id, name, description })),
  get: (id) => presets.find((p) => p.id === id)?.config,
};
