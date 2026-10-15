const { text } = require('./portable-track');
module.exports = function plan(rows, options = {}) {
  const mode = options.groupBy || 'single', size = Math.max(1, Math.min(10000, Number(options.splitSize) || 500));
  if (!['single', 'size', 'artist', 'album', 'genre'].includes(mode)) throw new Error('transfer_grouping_invalid');
  const groups = new Map(); let count = 0;
  for (const row of rows) {
    if (!row.selected) continue;
    const source = row.track?.candidate || row.selected; let label = '';
    if (mode === 'artist') label = source.artists?.[0] || 'Unknown artist';
    if (mode === 'album') label = source.album ? [source.artists?.[0], source.album].filter(Boolean).join(' - ') : 'Unknown album';
    if (mode === 'genre') label = source.genres?.[0] || 'Unknown genre';
    if (mode === 'size') label = 'Part ' + (Math.floor(count / size) + 1);
    label = text(label, 200);
    if (!groups.has(label)) groups.set(label, { name: text([options.name || 'Transferred playlist', label].filter(Boolean).join(' - '), 250), ids: [], tracks: [] });
    groups.get(label).ids.push(row.selected.providerItemId); count++;
    groups.get(label).tracks.push({ candidate: row.selected });
    if (groups.size > 100) throw new Error('transfer_group_limit');
  }
  return [...groups.values()];
};
