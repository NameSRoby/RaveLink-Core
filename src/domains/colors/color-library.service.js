// [TITLE] Module: domains/colors/color-library.service.js
// [TITLE] Purpose: learned color library + parse/teach runtime
// [TITLE] Functionality Index:
// [TITLE] - persistent custom color dictionary
// [TITLE] - deterministic teach semantics (including duplicate refund signal)
// [TITLE] - fuzzy-aware color lookup for chat typo resilience
// [TITLE] - runtime update events for immediate availability

const fs = require("fs");
const EventEmitter = require("events");
const {
  normalizeHex,
  hexToRgb
} = require("./color-space");
const {
  readJsonFileWithMetadata,
  writeJsonFile,
  cloneJsonSafe
} = require("../../shared/fs/json-file-store");
const {
  normalizeLookupToken,
  findBestFuzzyMatch
} = require("../../shared/fuzzy/fuzzy-text");

const TEACH_PATTERN_NAME_HEX = /^(.+?)(?:\s+|[:=,]\s*)(#[0-9a-f]{6})$/i;
const TEACH_PATTERN_HEX_NAME = /^(#[0-9a-f]{6})(?:\s+|[:=,]\s*)(.+)$/i;
const BASE_COLORS = Object.freeze({
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  cyan: "#00ffff",
  yellow: "#ffff00",
  purple: "#8000ff",
  pink: "#ff0080",
  white: "#ffffff"
});
const MAX_CUSTOM_COLORS = 1024;
const MAX_COLOR_NAME_LENGTH = 64;

function normalizeColorName(value) {
  return normalizeLookupToken(value).slice(0, MAX_COLOR_NAME_LENGTH);
}

function sanitizeColorMap(input = {}) {
  const out = {};
  for (const [name, rawHex] of Object.entries(input || {}).slice(0, MAX_CUSTOM_COLORS)) {
    const key = normalizeColorName(name);
    const hex = normalizeHex(rawHex);
    if (!key || !hex) continue;
    out[key] = hex;
  }
  return out;
}

module.exports = function createColorLibraryService(options = {}) {
  const storePath = String(options.storePath || "").trim();
  if (!storePath) {
    throw new Error("createColorLibraryService requires storePath");
  }
  const fuzzyMinScore = Number.isFinite(Number(options.fuzzyMinScore))
    ? Number(options.fuzzyMinScore)
    : 180;
  const seed = sanitizeColorMap(options.seedCustomColors || {});
  const emitter = new EventEmitter();

  let version = 1;
  let customColors = {};

  function load() {
    // [DEV] Seed write only occurs on first boot so user-learned colors are never overwritten.
    const hasFile = fs.existsSync(storePath) || fs.existsSync(`${storePath}.bak`);
    if (hasFile) {
      const loaded = readJsonFileWithMetadata(storePath, {});
      customColors = sanitizeColorMap(loaded.value);
      if (loaded.recovered || JSON.stringify(loaded.value) !== JSON.stringify(customColors)) writeJsonFile(storePath, customColors);
      return;
    }

    customColors = { ...seed };
    writeJsonFile(storePath, customColors);
  }

  function persistAndBroadcast(change = {}) {
    version += 1;
    writeJsonFile(storePath, customColors);
    emitter.emit("updated", {
      version,
      at: Date.now(),
      change,
      summary: getSummary()
    });
  }

  function getColorMap() {
    return {
      ...customColors,
      ...BASE_COLORS
    };
  }

  function getSummary() {
    return {
      version,
      baseCount: Object.keys(BASE_COLORS).length,
      customCount: Object.keys(customColors).length,
      totalCount: Object.keys(getColorMap()).length
    };
  }

  function findColorByHex(hex) {
    const safe = normalizeHex(hex);
    if (!safe) return null;
    const colorMap = getColorMap();
    for (const [name, value] of Object.entries(colorMap)) {
      if (String(value || "").toLowerCase() === safe) {
        return { name, hex: safe };
      }
    }
    return null;
  }

  function parseColorText(rawText, optionsOverride = {}) {
    // [DEV] Resolution order is intentional:
    // [DEV] 1) explicit HEX, 2) exact full phrase, 3) exact multi-word spans,
    // [DEV] 4) fuzzy full phrase, 5) exact single-token fallback.
    // [DEV] This avoids short-token false positives overshadowing taught names.
    const optionsSafe = optionsOverride && typeof optionsOverride === "object" ? optionsOverride : {};
    const allowFuzzy = optionsSafe.allowFuzzy !== false;
    const text = String(rawText || "").trim();
    if (!text) {
      return { ok: false, error: "missing color text" };
    }

    const words = text.split(/\s+/).filter(Boolean);
    const hexToken = words.find(word => /^#[0-9a-f]{6}$/i.test(word));
    if (hexToken) {
      const hex = normalizeHex(hexToken);
      return {
        ok: true,
        source: "hex",
        matchedName: "",
        hex,
        rgb: hexToRgb(hex),
        fuzzy: null
      };
    }

    const resolveExact = key => {
      if (!key) return null;
      if (Object.hasOwn(customColors, key) && !Object.hasOwn(BASE_COLORS, key)) {
        const hex = customColors[key];
        return {
          ok: true,
          source: "custom",
          matchedName: key,
          hex,
          rgb: hexToRgb(hex),
          fuzzy: null
        };
      }
      if (Object.hasOwn(BASE_COLORS, key)) {
        const hex = BASE_COLORS[key];
        return {
          ok: true,
          source: "base",
          matchedName: key,
          hex,
          rgb: hexToRgb(hex),
          fuzzy: null
        };
      }
      return null;
    };

    const normalizedWords = words.map(word => normalizeColorName(word)).filter(Boolean);
    const fullQuery = normalizeColorName(words.join(" "));
    const fullExact = resolveExact(fullQuery);
    if (fullExact) return fullExact;

    for (let start = 0; start < normalizedWords.length; start += 1) {
      for (let end = normalizedWords.length; end > start + 1; end -= 1) {
        const key = normalizeColorName(normalizedWords.slice(start, end).join(""));
        if (!key || key === fullQuery) continue;
        const exact = resolveExact(key);
        if (exact) return exact;
      }
    }

    if (allowFuzzy) {
      const colorMap = getColorMap();
      const candidates = Object.keys(colorMap);
      const hydrateFuzzy = fuzzy => {
        const matchedName = String(fuzzy?.value || "");
        const matchedHex = colorMap[matchedName];
        return {
          ok: true,
          source: Object.hasOwn(BASE_COLORS, matchedName) ? "base_fuzzy" : "custom_fuzzy",
          matchedName,
          hex: matchedHex,
          rgb: hexToRgb(matchedHex),
          fuzzy
        };
      };

      const fuzzyFull = findBestFuzzyMatch(fullQuery, candidates, {
        minScore: fuzzyMinScore, allowTranspositions: true
      });
      if (fuzzyFull) return hydrateFuzzy(fuzzyFull);

      // [DEV] Phrase wrappers are common in chat/redemption inputs
      // [DEV] ("make it gren please"), so we fuzzy-check embedded spans too.
      let bestSpan = null;
      for (let start = 0; start < normalizedWords.length; start += 1) {
        for (let end = normalizedWords.length; end > start; end -= 1) {
          const query = normalizeColorName(normalizedWords.slice(start, end).join(""));
          if (!query || query === fullQuery) continue;
          const fuzzySpan = findBestFuzzyMatch(query, candidates, {
            minScore: fuzzyMinScore, allowTranspositions: true
          });
          if (!fuzzySpan) continue;
          if (!bestSpan || fuzzySpan.score > bestSpan.score) {
            bestSpan = fuzzySpan;
          }
        }
      }
      if (bestSpan) return hydrateFuzzy(bestSpan);
    }

    for (const token of normalizedWords) {
      const exact = resolveExact(token);
      if (exact) return exact;
    }

    return { ok: false, error: "unknown color" };
  }

  function teachColor(rawInput) {
    // [DEV] Teach semantics are strict by design:
    // [DEV] - changed=false + refundRecommended=true means "safe no-op duplicate"
    // [DEV]   so channel points handlers can refund without guessing.
    const text = String(rawInput || "").trim();
    if (!text) {
      return {
        ok: false,
        changed: false,
        reason: "empty_input",
        refundRecommended: false,
        name: "",
        hex: ""
      };
    }

    const nameHexMatch = text.match(TEACH_PATTERN_NAME_HEX);
    const hexNameMatch = nameHexMatch ? null : text.match(TEACH_PATTERN_HEX_NAME);
    if (!nameHexMatch && !hexNameMatch) {
      return {
        ok: false,
        changed: false,
        reason: "invalid_format",
        refundRecommended: false,
        name: "",
        hex: ""
      };
    }

    const rawName = nameHexMatch ? nameHexMatch[1] : hexNameMatch[2];
    const rawHex = nameHexMatch ? nameHexMatch[2] : hexNameMatch[1];
    const name = normalizeColorName(rawName);
    const hex = normalizeHex(rawHex);
    if (!name) {
      return {
        ok: false,
        changed: false,
        reason: "invalid_name",
        refundRecommended: false,
        name: "",
        hex: hex || ""
      };
    }
    if (!hex) {
      return {
        ok: false,
        changed: false,
        reason: "invalid_hex",
        refundRecommended: false,
        name,
        hex: ""
      };
    }

    if (BASE_COLORS[name]) {
      return {
        ok: true,
        changed: false,
        reason: "name_exists_base",
        refundRecommended: true,
        name,
        hex: BASE_COLORS[name]
      };
    }

    if (customColors[name]) {
      const existing = String(customColors[name]).toLowerCase();
      return {
        ok: true,
        changed: false,
        reason: existing === hex ? "already_exists" : "name_exists_custom",
        refundRecommended: true,
        name,
        hex: existing
      };
    }

    const existingHex = findColorByHex(hex);
    if (existingHex) {
      return {
        ok: true,
        changed: false,
        reason: "hex_exists",
        refundRecommended: true,
        name: existingHex.name,
        hex: existingHex.hex
      };
    }

    if (Object.keys(customColors).length >= MAX_CUSTOM_COLORS) {
      return { ok: false, changed: false, reason: "custom_color_limit_reached", refundRecommended: true, name, hex };
    }

    customColors[name] = hex;
    persistAndBroadcast({
      type: "teach",
      name,
      hex
    });
    return {
      ok: true,
      changed: true,
      reason: "taught",
      refundRecommended: false,
      name,
      hex
    };
  }

  function onUpdated(listener) {
    if (typeof listener !== "function") return () => {};
    emitter.on("updated", listener);
    return () => emitter.off("updated", listener);
  }

  load();

  return {
    normalizeColorName,
    parseColorText,
    teachColor,
    findColorByHex,
    getColorMapSnapshot() {
      return cloneJsonSafe(getColorMap(), {});
    },
    getSummary,
    onUpdated
  };
};

module.exports.MAX_CUSTOM_COLORS = MAX_CUSTOM_COLORS;
module.exports.MAX_COLOR_NAME_LENGTH = MAX_COLOR_NAME_LENGTH;
