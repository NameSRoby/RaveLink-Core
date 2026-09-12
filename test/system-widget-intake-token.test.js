const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeWidgetIntakeToken,
  readWidgetIntakeTokenFromRequest,
  timingSafeTokenEqual
} = require("../src/domains/system/widget-intake-token");

test("widget intake token helper reads bearer token before body fallback", () => {
  const req = {
    headers: {
      authorization: "Bearer header-token"
    }
  };
  const body = {
    widgetConfig: {
      widgetIntakeToken: "body-token"
    }
  };

  assert.equal(readWidgetIntakeTokenFromRequest(req, body), "header-token");
});

test("widget intake token helper parses a bounded bearer scheme without a backtracking expression", () => {
  assert.equal(readWidgetIntakeTokenFromRequest({ headers: { authorization: "bEaReR token" } }), "token");
  assert.equal(readWidgetIntakeTokenFromRequest({ headers: { authorization: "Bearer\ttoken" } }), "");
  assert.equal(readWidgetIntakeTokenFromRequest({ headers: { authorization: `Bearer ${"x".repeat(2048)}` } }).length, 512);
});

test("widget intake token helper reads widget config token fallback", () => {
  assert.equal(
    readWidgetIntakeTokenFromRequest({ headers: {} }, { widgetConfig: { widgetIntakeToken: "body-token" } }),
    "body-token"
  );
});

test("widget intake token helper compares exact scoped tokens", () => {
  assert.equal(normalizeWidgetIntakeToken("  abc  "), "abc");
  assert.equal(timingSafeTokenEqual("abc", "abc"), true);
  assert.equal(timingSafeTokenEqual("abc", "abcd"), false);
  assert.equal(timingSafeTokenEqual("", "abc"), false);
});
