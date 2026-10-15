const { exportCsv } = require('./playlist-csv');
module.exports = async ({ context, library, job, rows, input }) => {
  let contents, name;
  if (input.report) {
    if (!job || input.jobId !== job.id) throw new Error('transfer_changed');
    name = job.name + '-report';
    contents = exportCsv(rows.map(row => ({ candidate: row.track?.candidate || row.raw || { title: row.error }, report: { status: row.selected ? 'selected' : row.error ? 'unresolved' : row.include === false ? 'skipped' : 'source', destinationId: row.selected?.providerItemId || '', score: row.selected?.score || '', error: row.error || '' } })), 0, true);
  } else {
    const source = require('./playlist-export-source')({ library, job, rows, input });
    name = source.name; contents = exportCsv(source.tracks);
  }
  contents = '\ufeff' + contents;
  if (Buffer.byteLength(contents) > 8388608) throw new Error('export_file_limit');
  const call = async payload => { const result = await context.callCapability('playlist.exports.host.v1', 'action', payload, { timeoutMs: 5000 }); if (!result.ok) throw new Error(result.code || 'export_file_failed'); return result; };
  const upload = await call({ action: 'begin', name });
  try {
    for (let offset = 0, chunk = 0; offset < contents.length; chunk++) {
      // Keep surrogate pairs together so exported non-BMP titles survive chunk boundaries.
      let end = Math.min(offset + 12000, contents.length);
      if (end < contents.length && /[\uD800-\uDBFF]/.test(contents[end - 1])) end--;
      await call({ action: 'append', id: upload.id, offset, chunk: contents.slice(offset, end) }); offset = end;
      if (chunk % 40 === 39) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return await call({ action: 'finish', id: upload.id });
  } catch (error) { await call({ action: 'cancel', id: upload.id }).catch(() => {}); throw error; }
};
