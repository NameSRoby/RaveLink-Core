/** Draw once per activation. Bounded lightness/chroma and pairwise Oklab
 * separation keep generated stops distinct. This is a color-coordinate guard,
 * not a measurement of a bulb's physical brightness or a visibility guarantee.
 */
const { fromOklch, oklch } = require("./palette-math.cjs");
const MIN_DISTANCE = 0.1;
const { family } = require("./temperature-colors.cjs");
const lab = (rgb) => {
  const [l, c, h] = oklch(rgb);
  return [l, c * Math.cos(h), c * Math.sin(h)];
};
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
function candidate(random, offset = 0) {
  const draw = () => {
    const n = random();
    if (!Number.isFinite(n) || n < 0 || n >= 1)
      throw Object.assign(Error("invalid_music_random"), { code: "invalid_music_random" });
    return n;
  };
  const count = 3 + Math.floor(draw() * 5),
    rotation = draw() * 2 * Math.PI + offset;
  const candidates = Array.from({ length: 96 }, (_, i) => {
    const rgb = fromOklch([
      0.7 + draw() * 0.06,
      0.2 + draw() * 0.05,
      rotation + ((i + draw()) / 96) * 2 * Math.PI,
    ]);
    return { rgb, lab: lab(rgb), weight: 0.9 + draw() * 0.2 };
  });
  const picked = [candidates.splice(Math.floor(draw() * candidates.length), 1)[0]];
  while (picked.length < count) {
    const required = ["warm", "cool"].find((kind) => !picked.some((p) => family(p.rgb) === kind));
    let best = -1,
      score = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (required && family(candidates[i].rgb) !== required) continue;
      const nearest = Math.min(...picked.map((p) => distance(p.lab, candidates[i].lab)));
      if (nearest >= MIN_DISTANCE && nearest * candidates[i].weight > score) {
        best = i;
        score = nearest * candidates[i].weight;
      }
    }
    // Prefer fewer distinct colors to padding the palette with near-duplicates.
    if (best < 0) break;
    picked.push(candidates.splice(best, 1)[0]);
  }
  return picked.map(({ rgb }) => "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join(""));
}
function generate(random = Math.random, history = null) {
  if (!history?.recent) return candidate(random);
  const previous = history.recent("generated-palettes").map((colors) => colors.map((c) => lab(c)));
  let winner,
    best = -Infinity;
  for (let i = 0; i < 16; i++) {
    const colors = candidate(random, i * 2.399963229728653);
    const points = colors.map((c) => lab([1, 3, 5].map((at) => parseInt(c.slice(at, at + 2), 16))));
    const novelty = previous.map((prior) => {
      const nearest = (from, to) =>
        from.reduce((sum, p) => sum + Math.min(...to.map((q) => distance(p, q))), 0) / from.length;
      return (nearest(points, prior) + nearest(prior, points)) / 2;
    });
    // Compare color sets, so merely reordering the same stops is not novelty.
    const score = novelty.length
      ? 2 * novelty.at(-1) +
        Math.min(...novelty) +
        novelty.reduce((a, b) => a + b, 0) / novelty.length
      : -i;
    if (score > best) {
      winner = colors;
      best = score;
    }
  }
  history.remember(
    "generated-palettes",
    winner.map((c) => [1, 3, 5].map((at) => parseInt(c.slice(at, at + 2), 16))),
  );
  return winner;
}
module.exports = generate;
module.exports.MIN_DISTANCE = MIN_DISTANCE;
