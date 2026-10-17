/**
 * Deterministic codec for tests of lighting routes and presentation.
 * This is encoding, not encryption, and must never be used by runtime code.
 * OS encryption is covered independently by windows-dpapi.test.js; these tests
 * need stable fixture storage rather than a dependency on PowerShell startup.
 */
const map = (input, convert) =>
  Object.fromEntries(Object.entries(input).map(([key, value]) => [key, convert(value)]));
module.exports = {
  protect: (input) => ({
    ok: true,
    encrypted: map(input, (value) => Buffer.from(value).toString("base64")),
  }),
  unprotect: (input) => ({
    ok: true,
    plain: map(input, (value) => Buffer.from(value, "base64").toString()),
  }),
};
