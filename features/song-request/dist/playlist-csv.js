const { normalizeTrack } = require('./portable-track');
const COLUMNS = ['position', 'title', 'artists', 'album', 'duration_ms', 'isrc', 'source_provider', 'source_id', 'source_url', 'version', 'genres', 'ravelink_csv_version'];
const MAX_BYTES = 8388608;
function parseCells(input, delimiter = ',') {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BYTES || ![',', ';', '\t'].includes(delimiter)) throw new Error('csv_file_limit');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const push = () => { if (cell.length > 8192 || row.length >= 40) throw new Error('csv_field_limit'); row.push(cell); cell = ''; closed = false; };
  for (let index = input.charCodeAt(0) === 0xfeff ? 1 : 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) { if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; } else if (char === '"') { quoted = false; closed = true; } else cell += char; }
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === delimiter) push();
    else if (char === '\n' || char === '\r') { push(); rows.push(row); row = []; if (char === '\r' && input[index + 1] === '\n') index++; if (rows.length > 10001) throw new Error('csv_row_limit'); }
    else { if (closed || char === '"') throw new Error('csv_quotes_invalid'); cell += char; }
    if (cell.length > 8192) throw new Error('csv_field_limit');
  }
  if (quoted) throw new Error('csv_quotes_invalid');
  if (cell || row.length || closed) { push(); rows.push(row); }
  if (rows.length > 10001) throw new Error('csv_row_limit');
  return rows;
}
function parseCsv(input, { delimiter = ',', mapping = {} } = {}) {
  const rows = parseCells(input, delimiter), headers = rows.shift()?.map(value => value.trim().toLowerCase()) || [];
  if (!headers.length || new Set(headers).size !== headers.length) throw new Error('csv_headers_invalid');
  const at = name => headers.indexOf(mapping[name] || name);
  if (at('title') < 0) throw new Error('csv_title_column_required');
  return rows.filter(row => row.some(Boolean)).map((row, index) => {
    const own = row[headers.indexOf('ravelink_csv_version')] === '1';
    const get = name => { const value = row[at(name)] || ''; return own && value.startsWith("'") ? value.slice(1) : value; };
    const raw = { provider: get('source_provider') || 'local', providerItemId: get('source_id'), title: get('title'), artists: get('artists').split(' | ').filter(Boolean), album: get('album'),
      durationMs: Number(get('duration_ms')) || 0, isrc: get('isrc'), sourceUrl: get('source_url'), version: get('version'), genres: get('genres').split(' | ').filter(Boolean) };
    const track = normalizeTrack(raw);
    const oversized = raw.title.length > 300 || raw.album.length > 200 || raw.providerItemId.length > 160 || raw.artists.length > 8 || raw.artists.some(value => value.length > 100) || raw.genres.length > 8 || raw.genres.some(value => value.length > 60);
    const error = row.length !== headers.length ? 'Column count does not match header' : oversized ? 'Track metadata exceeds supported field lengths' : !track ? 'Invalid track/provider identity' : (!raw.title || !raw.artists.length) && raw.provider === 'local' ? 'Title and artist are required for unmatched tracks' : '';
    const bounded = { ...raw, title: raw.title.slice(0, 300), artists: raw.artists.slice(0, 8).map(value => value.slice(0, 100)), album: raw.album.slice(0, 200), provider: raw.provider.slice(0, 40), providerItemId: raw.providerItemId.slice(0, 160), isrc: raw.isrc.slice(0, 20), sourceUrl: raw.sourceUrl.slice(0, 500), version: raw.version.slice(0, 100), genres: raw.genres.slice(0, 8).map(value => value.slice(0, 60)) };
    return { row: index + 2, track: error ? null : track, error, raw: error ? bounded : null };
  });
}
const cell = value => {
  let raw = String(value ?? '');
  if (/^(?:'|[\t\r\n ]*[=+@-])/.test(raw)) raw = "'" + raw;
  return '"' + raw.replace(/"/g, '""') + '"';
};
function exportCsv(rows, offset = 0, report = false) {
  const columns = report ? [...COLUMNS, 'transfer_status', 'destination_id', 'match_score', 'error'] : COLUMNS;
  return (offset === 0 ? columns.join(',') + '\r\n' : '') + rows.map((row, index) => {
    const c = row.candidate || row;
    const values = [offset + index + 1, c.title, (c.artists || []).join(' | '), c.album, c.durationMs || '', c.isrc, c.provider, c.providerItemId, c.sourceUrl, c.version, (c.genres || []).join(' | '), 1];
    return [...values, ...(report ? [row.report.status, row.report.destinationId, row.report.score, row.report.error] : [])].map(cell).join(',') + '\r\n';
  }).join('');
}
module.exports = { parseCells, parseCsv, exportCsv, COLUMNS, MAX_BYTES };
