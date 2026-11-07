const test = require("node:test");
const assert = require("node:assert/strict");
const index = require("../beat-palette.cjs");

test("color phrases stay consistent for four hits and every hit advances", () => {
  assert.deepEqual(
    Array.from({ length: 12 }, (_, i) => index(i, 3)),
    [0, 1, 0, 1, 2, 1, 2, 1, 2, 0, 2, 0],
  );
  for (let length = 2; length <= 8; length++) {
    const chosen = Array.from({ length: 256 }, (_, i) => index(i, length));
    assert(chosen.every((n) => Number.isInteger(n) && n >= 0 && n < length));
    assert(
      chosen.every((n, i) => i === 0 || n !== chosen[i - 1]),
      "a phrase boundary must not hide a hit",
    );
    assert.equal(
      new Set(chosen).size,
      length,
      "the progression must visit the entire allowed palette",
    );
  }
});
