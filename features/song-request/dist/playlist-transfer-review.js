/**
 * Stable-identity playlist review pages.
 * Sorted/filtered views display original row indices so edits target the correct
 * occurrence. Ordinary pages must not clone the full source; only the five returned
 * rows need copies. Automatic acceptance preserves explicit manual review decisions.
 */
const score = (row) => row.selected?.score ?? row.choices?.[0]?.score ?? 0;
exports.page = (rows, input = {}) => {
  // Keep the ordinary page O(page size): polling must not clone every track in
  // a 10,000-row transfer. Filtered views carry indices, preserving edit identity
  // even when scores reorder the displayed rows. Only returned rows are copied.
  let indices = null;
  const threshold = input.threshold ?? 95;
  if (["needs_review", "unmatched", "weakest"].includes(input.review)) {
    indices = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (input.review === "needs_review" && row.selected && score(row) >= threshold) continue;
      if (input.review === "unmatched" && row.choices?.length) continue;
      indices.push(index);
    }
    if (input.review !== "unmatched")
      indices.sort((a, b) => score(rows[a]) - score(rows[b]) || a - b);
  }
  const total = indices ? indices.length : rows.length;
  const offset = Math.max(0, Math.min(total, Math.trunc(Number(input.offset) || 0)));
  const pageRows = [];
  for (let cursor = offset; cursor < Math.min(total, offset + 5); cursor++) {
    const index = indices ? indices[cursor] : cursor;
    pageRows.push({ ...rows[index], index });
  }
  return {
    rows: pageRows,
    page: { offset, total, hasMore: offset + 5 < total },
  };
};
exports.accept = (rows, threshold = 95) => {
  if (!Number.isInteger(threshold) || threshold < 50 || threshold > 100)
    throw new Error("transfer_threshold_invalid");
  for (const row of rows)
    if (!row.manuallyReviewed && row.include !== false)
      row.selected =
        row.choices[0]?.score >= threshold && row.choices[0]?.autoSelectable !== false
          ? row.choices[0]
          : null;
};
