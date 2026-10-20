/** Activation-only weighted sampling without replacement. History is local to
 * one controller and bounded; changes to allowed choices/weights reset that bag.
 * Weights are odds among remaining candidates, not long-run frequency promises:
 * every candidate is visited once per completed bag. Boundary repeats can occur.
 */
module.exports = function createHistory() {
  const bags = new Map();
  function draw(key, values, random = Math.random) {
    const allowed = values.filter((v) => v.weight > 0);
    if (!allowed.length) return null;
    const signature = JSON.stringify(allowed);
    let bag = bags.get(key);
    if (!bag || bag.signature !== signature || bag.used.size === allowed.length) {
      bag = { signature, used: new Set() };
      bags.delete(key);
      if (bags.size >= 256) bags.delete(bags.keys().next().value);
      bags.set(key, bag);
    }
    const remaining = allowed.filter((v) => !bag.used.has(v.id));
    const total = remaining.reduce((sum, v) => sum + v.weight, 0);
    let winner = null;
    for (const value of remaining) {
      const roll = random();
      if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw Error("invalid_music_random");
      const priority =
        Math.log(-Math.log(Math.max(Number.MIN_VALUE, roll))) - Math.log(value.weight);
      if (!winner || priority < winner.priority) winner = { id: value.id, roll, priority };
    }
    bag.used.add(winner.id);
    return {
      ...winner,
      probabilities: Object.fromEntries(
        allowed.map((v) => [v.id, remaining.includes(v) ? v.weight / total : 0]),
      ),
    };
  }
  return { draw };
};
