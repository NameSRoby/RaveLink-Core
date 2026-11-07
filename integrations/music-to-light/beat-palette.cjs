/** Alternate neighboring colors for four measured hits, then move to the next
 * pair. Every hit changes color; the phrase never redraws a random palette.
 */
module.exports = function beatPaletteIndex(hits, length) {
  const phrase = Math.floor(hits / 4);
  const side = (hits % 2) ^ (phrase % 2);
  return (phrase + side) % length;
};
