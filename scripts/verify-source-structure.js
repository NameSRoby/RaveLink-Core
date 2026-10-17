#!/usr/bin/env node
/**
 * Bound implementation size independently of whitespace and developer notes.
 * Line limits rewarded compressed source and rejected readable formatting. Tokens
 * and actual if-statements measure authored code instead; exceptions record the
 * few existing large modules rather than silently lifting every module's budget.
 */
const { audit } = require("./audit-repository-health");
const DEFAULT_LIMITS = Object.freeze({ tokens: 6500, branches: 60 });
const DEBT_LIMITS = Object.freeze({
  "src/adapters/brands/hue-bridge.adapter.js": { tokens: 9800, branches: 110 },
  "src/adapters/brands/hue-entertainment.runtime.js": { tokens: 6000, branches: 65 },
  "src/app/core/register-lighting-core.routes.js": { tokens: 7000, branches: 70 },
  "public/core/core.js": { tokens: 9300, branches: 50 },
  "features/song-request/dist/domain.js": { tokens: 8500, branches: 82 },
  "features/song-request/ui/designer-controls.js": { tokens: 8300, branches: 60 },
});
function verify() {
  const result = audit();
  const rows = result.metrics.filter((row) =>
    /^(?:src\/|public\/core\/|features\/)/.test(row.file),
  );
  const failures = [...result.errors];
  for (const row of rows) {
    const limits = DEBT_LIMITS[row.file] || DEFAULT_LIMITS;
    if (row.tokens > limits.tokens)
      failures.push(`${row.file}: ${row.tokens} tokens exceeds ${limits.tokens}`);
    if (row.branches > limits.branches)
      failures.push(`${row.file}: ${row.branches} if branches exceeds ${limits.branches}`);
  }
  return { ok: failures.length === 0, failures, files: rows.length };
}
if (require.main === module) {
  const result = verify();
  result.failures.forEach((failure) => console.error(`[STRUCTURE] ${failure}`));
  if (!result.ok) process.exitCode = 1;
  else console.log(`[STRUCTURE] ${result.files} implementation files verified.`);
}
module.exports = { DEFAULT_LIMITS, DEBT_LIMITS, verify };
