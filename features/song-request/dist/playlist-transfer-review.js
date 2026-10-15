const score = row => row.selected?.score ?? row.choices?.[0]?.score ?? 0;
exports.page = (rows, input = {}) => {
  let view = rows.map((row, index) => ({ ...row, index }));
  const threshold = input.threshold ?? 95;
  if (input.review === 'needs_review') view = view.filter(row => !row.selected || score(row) < threshold);
  if (input.review === 'unmatched') view = view.filter(row => !row.choices?.length);
  if (input.review === 'weakest' || input.review === 'needs_review') view.sort((a, b) => score(a) - score(b) || a.index - b.index);
  const offset = Math.max(0, Math.min(view.length, Number(input.offset) || 0));
  return { rows: view.slice(offset, offset + 5), page: { offset, total: view.length, hasMore: offset + 5 < view.length } };
};
exports.accept = (rows, threshold = 95) => {
  if (!Number.isInteger(threshold) || threshold < 50 || threshold > 100) throw new Error('transfer_threshold_invalid');
  for (const row of rows) if (!row.manuallyReviewed && row.include !== false) row.selected = row.choices[0]?.score >= threshold && row.choices[0]?.autoSelectable !== false ? row.choices[0] : null;
};
