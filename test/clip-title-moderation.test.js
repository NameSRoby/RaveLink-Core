const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaults,
  normalizePolicy,
  moderateTitle,
} = require("../src/domains/twitch/clip-title-moderation");
test("clip titles mask profanity and common disguises, retaining Unicode positions", () => {
  for (const value of ["fuck", "FUCK", "f.u.c.k", "f\u200buck", "ＦＵＣＫ", "sh1t"])
    assert.equal(moderateTitle(`🎮 ${value} clutch`, defaults()).title, "🎮 **** clutch", value);
  for (const title of ["class action", "Scunthorpe", "assassin clutch", "3k on tracer"])
    assert.equal(moderateTitle(title, defaults()).title, title);
});
test("custom terms are literal whole words or phrases and allow exceptions cannot excuse longer words", () => {
  const policy = normalizePolicy({
    useDefaultList: false,
    blockedWords: ["spoiler", "café", "a+b", "[secret]", "bad phrase", "ass", "asshole"],
    allowedWords: ["ass", "bad phrase allowed"],
  });
  assert.equal(
    moderateTitle("SPOILER spoilerish cafe\u0301 a+b [secret] bad phrase", policy).title,
    "**** spoilerish **** **** **** ****",
  );
  assert.equal(
    moderateTitle("ass asshole bad phrase allowed bad phrase", policy).title,
    "ass **** bad phrase allowed ****",
  );
  assert.equal(moderateTitle("Caféine spoileré", policy).matched, false);
});
test("rejection never returns the blocked title; disabled filtering is explicit", () => {
  assert.deepEqual(
    moderateTitle("bad word", normalizePolicy({ mode: "reject", blockedWords: ["bad"] })),
    { accepted: false, title: "", matched: true, error: "twitch_clip_title_rejected" },
  );
  assert.equal(
    moderateTitle("bad word", normalizePolicy({ enabled: false, blockedWords: ["bad"] })).title,
    "bad word",
  );
  assert.equal(moderateTitle("", defaults()).title, "");
});
test("title limits never expose part of a blocked word or split replacement markers/surrogates", () => {
  const policy = normalizePolicy({ useDefaultList: false, blockedWords: ["x"] });
  const title = moderateTitle("x ".repeat(50), policy).title;
  assert(title.length <= 100);
  assert(!title.includes("x"));
  assert(!/(?<!\*)\*{1,3}(?!\*)/.test(title));
  assert(!/[\ud800-\udbff]$/.test(moderateTitle("a".repeat(99) + "🎮", defaults()).title));
});
test("policy is bounded, rejects executable patterns/options, and cannot share caller-owned lists", () => {
  for (const value of [
    null,
    [],
    { mode: "script" },
    { enabled: 1 },
    { regex: ".*" },
    { blockedWords: [""] },
    { blockedWords: ["a".repeat(65)] },
    { allowedWords: Array(129).fill("ok") },
    { blockedWords: ["hello\nworld"] },
  ])
    assert.throws(() => normalizePolicy(value), /moderation_invalid/);
  const input = { blockedWords: ["spoiler"] },
    policy = normalizePolicy(input);
  input.blockedWords.push("other");
  assert.deepEqual(policy.blockedWords, ["spoiler"]);
});
