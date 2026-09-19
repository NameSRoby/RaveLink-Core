const OVERLAY_BLOCK_KINDS = Object.freeze(["label", "title", "artists", "album", "artwork", "meta", "provider", "time", "progress", "queue"]);
const OVERLAY_BLOCK_SIZES = Object.freeze(["inherit", "small", "medium", "large", "display"]);
const OVERLAY_FONTS = Object.freeze(["inherit", "system", "serif", "mono", "cjk"]);
const DEFAULT_OVERLAY = Object.freeze({
  version: 3, preset: "classic", flow: "column", anchor: "top-left", separated: false,
  width: 320, autoHeight: true, height: 130, contentAlign: "start", scale: 100,
  gap: 6, blockGap: 3, padding: 10, radius: 4, opacity: 78, accentWidth: 4, shadow: 70,
  accent: "#e21d48", surface: "#05070c", text: "#ffffff", muted: "#b8c2d8", motion: "subtle",
  segments: Object.freeze([Object.freeze({
    id: "main", enabled: true, direction: "column", align: "left", size: "wide",
    blocks: Object.freeze([
      Object.freeze({ id: "now-playing", kind: "label" }), Object.freeze({ id: "song-title", kind: "title" }),
      Object.freeze({ id: "song-artists", kind: "artists" }), Object.freeze({ id: "playback-meta", kind: "meta" }),
      Object.freeze({ id: "playback-progress", kind: "progress" }), Object.freeze({ id: "up-next", kind: "queue", count: 3 })
    ])
  })])
});

function text(value, maximum) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function integer(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function overlayFrom(input, fallback = DEFAULT_OVERLAY) {
  const rawSource = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const legacyClassic = rawSource.version === 2 && rawSource.preset === "classic" && (
    rawSource.width === 660 && rawSource.padding === 16 && rawSource.opacity === 90
    || rawSource.width === 560 && rawSource.padding === 10 && rawSource.opacity === 0
    || rawSource.width === 320 && rawSource.padding === 10 && rawSource.opacity === 0
  );
  const source = legacyClassic ? { ...rawSource, anchor: "top-left", width: 320, gap: 6, blockGap: 3, padding: 10, radius: 4, opacity: 78 } : rawSource;
  const color = (value, previous) => /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? String(value).toLowerCase() : previous;
  const oneOf = (value, values, previous) => values.includes(value) ? value : previous;
  const optionalInteger = (value, minimum, maximum) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
  };
  const blockStyleFrom = value => {
    const style = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.freeze({
      size: oneOf(style.size, OVERLAY_BLOCK_SIZES, "inherit"), font: oneOf(style.font, OVERLAY_FONTS, "inherit"),
      color: color(style.color, ""), bold: style.bold === true, italic: style.italic === true, uppercase: style.uppercase === true
    });
  };
  const segmentStyleFrom = value => {
    const style = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.freeze({
      surface: color(style.surface, ""), accent: color(style.accent, ""), opacity: optionalInteger(style.opacity, 0, 100),
      padding: optionalInteger(style.padding, 0, 48), radius: optionalInteger(style.radius, 0, 48), accentWidth: optionalInteger(style.accentWidth, 0, 12)
    });
  };
  const sourceSegments = Array.isArray(source.segments) ? source.segments.slice(0, 8) : fallback.segments;
  const seen = new Set();
  const seenBlocks = new Set();
  const segments = [];
  for (const raw of sourceSegments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = text(raw.id, 40).toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const explicitBlocks = Array.isArray(raw.blocks);
    let rawBlocks = explicitBlocks ? raw.blocks : [];
    if (!rawBlocks.length && raw.kind) {
      if (raw.kind === "track") rawBlocks = ["label", "title", ...(raw.variant === "title" ? [] : ["artists"]), ...(raw.variant === "full" ? ["album"] : [])].map((kind, index) => ({ id: `${id}-${kind}-${index}`, kind }));
      else if (raw.kind === "playback") rawBlocks = [...(raw.variant === "progress" ? [] : ["meta"]), ...(raw.variant === "time" ? [] : ["progress"])].map((kind, index) => ({ id: `${id}-${kind}-${index}`, kind }));
      else rawBlocks = [{ id: `${id}-${raw.kind}`, kind: raw.kind, count: raw.count }];
    }
    const blocks = [];
    for (const rawBlock of rawBlocks.slice(0, 12)) {
      if (seenBlocks.size >= 32) break;
      const kind = oneOf(rawBlock?.kind, OVERLAY_BLOCK_KINDS, "");
      const blockId = text(rawBlock?.id, 40).toLowerCase();
      if (!kind || !/^[a-z][a-z0-9-]{1,39}$/.test(blockId) || seenBlocks.has(blockId)) continue;
      seenBlocks.add(blockId);
      blocks.push(Object.freeze({ id: blockId, kind, count: kind === "queue" ? integer(rawBlock.count, 1, 5, 3) : undefined, style: blockStyleFrom(rawBlock.style) }));
    }
    if (!blocks.length && !explicitBlocks) continue;
    segments.push(Object.freeze({
      id, name: text(raw.name, 40) || `Segment ${segments.length + 1}`, enabled: raw.enabled !== false,
      direction: oneOf(raw.direction, ["column", "row"], "column"), align: oneOf(raw.align, ["left", "center", "right"], "left"),
      size: oneOf(raw.size, ["compact", "wide", "full"], "wide"), style: segmentStyleFrom(raw.style), blocks: Object.freeze(blocks)
    }));
  }
  if (!segments.length) return overlayFrom(DEFAULT_OVERLAY, DEFAULT_OVERLAY);
  return Object.freeze({
    version: 3, preset: oneOf(source.preset, ["classic", "custom"], fallback.preset), flow: oneOf(source.flow, ["column", "row", "grid"], fallback.flow),
    anchor: oneOf(source.anchor, ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"], fallback.anchor),
    separated: typeof source.separated === "boolean" ? source.separated : fallback.separated,
    width: integer(source.width, 240, 960, fallback.width), autoHeight: typeof source.autoHeight === "boolean" ? source.autoHeight : fallback.autoHeight,
    height: integer(source.height, 80, 600, fallback.height), contentAlign: oneOf(source.contentAlign, ["start", "center", "end"], fallback.contentAlign),
    scale: integer(source.scale, 75, 150, fallback.scale), gap: integer(source.gap, 0, 40, fallback.gap), blockGap: integer(source.blockGap, 0, 24, fallback.blockGap),
    padding: integer(source.padding, 8, 36, fallback.padding), radius: integer(source.radius, 0, 40, fallback.radius), opacity: integer(source.opacity, 0, 100, fallback.opacity),
    accentWidth: integer(source.accentWidth, 0, 12, fallback.accentWidth), shadow: integer(source.shadow, 0, 100, fallback.shadow), accent: color(source.accent, fallback.accent),
    surface: color(source.surface, fallback.surface), text: color(source.text, fallback.text), muted: color(source.muted, fallback.muted),
    motion: oneOf(source.motion, ["off", "subtle", "slide"], fallback.motion), segments: Object.freeze(segments)
  });
}

module.exports = { DEFAULT_OVERLAY, OVERLAY_BLOCK_KINDS, overlayFrom };
