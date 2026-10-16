const { parseCells, parseCsv, MAX_BYTES } = require('./playlist-csv');
module.exports = function uploadSession(install, limit = () => 5000) {
  let upload = null;
  return async input => {
    if (input.action === 'upload_begin') {
      upload = { text: '', bytes: 0, name: input.name, delimiter: input.delimiter || ',' };
      return { ok: true };
    }
    if (!upload) throw new Error('csv_upload_invalid');
    if (input.action === 'upload_chunk') {
      if (input.offset !== upload.text.length || typeof input.chunk !== 'string' || input.chunk.length > 6000) throw new Error('csv_upload_invalid');
      upload.bytes += Buffer.byteLength(input.chunk); if (upload.bytes > MAX_BYTES) { upload = null; throw new Error('csv_file_limit'); }
      upload.text += input.chunk; return { ok: true };
    }
    if (input.action === 'upload_headers') {
      const cells = parseCells(upload.text, upload.delimiter);
      return { ok: true, headers: cells[0]?.map(value => value.trim().toLowerCase()) || [], count: cells.length - 1 };
    }
    const parsed = parseCsv(upload.text, { delimiter: upload.delimiter, mapping: input.mapping || {} });
    if (parsed.length > limit()) throw new Error('playlist_track_limit');
    if (!parsed.length) throw new Error('playlist_empty');
    await install(parsed.map(row => ({ ...row, choices: [], selected: null, include: !row.error })), upload.name, input.sourceKind === 'soundcloud' ? 'soundcloud' : 'csv'); upload = null;
    return null;
  };
};
