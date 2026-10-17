const test = require("node:test");
const assert = require("node:assert/strict");
const reportRow = require("../features/song-request/dist/playlist-transfer-report-row");

test("report rows preserve raw failures and share selected/error/exclusion precedence", () => {
  const selected = { providerItemId: "destination", score: 99 };
  const rows = [
    { track: { candidate: { title: "Matched" } }, selected, include: false },
    { raw: { title: "Missing" }, error: "no_match", include: false },
    { track: { candidate: { title: "Skipped" } }, include: false },
    { track: { candidate: { title: "Source" } } },
    { error: "invalid row" },
  ].map(reportRow);
  assert.deepEqual(
    rows.map((row) => row.report.status),
    ["selected", "unresolved", "skipped", "source", "unresolved"],
  );
  assert.deepEqual(
    rows.map((row) => row.candidate.title),
    ["Matched", "Missing", "Skipped", "Source", "invalid row"],
  );
  assert.equal(rows[0].report.destinationId, "destination");
  assert.equal(rows[0].report.score, 99);
});
