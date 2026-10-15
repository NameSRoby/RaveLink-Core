const { exportCsv } = require('./playlist-csv');
module.exports = ({ library, job, rows, input, offset }) => {
    if (input.action === 'export_csv') {
      const source = require('./playlist-export-source')({ library, job, rows, input });
      if (input.revision && input.revision !== source.revision) throw new Error('playlist_changed_export_again');
      return { ok: true, csv: exportCsv(source.tracks.slice(offset, offset + 10), offset), revision: source.revision, count: source.tracks.length };
    }
    if (input.action === 'export_report') {
      if (!job || input.jobId !== job.id || input.revision && input.revision !== job.revision) throw new Error('transfer_changed');
      return { ok: true, csv: exportCsv(rows.slice(offset, offset + 10).map(row => ({ candidate: row.track?.candidate || row.raw || { title: row.error },
        report: { status: row.selected ? 'selected' : row.error ? 'unresolved' : row.include === false ? 'skipped' : 'source', destinationId: row.selected?.providerItemId || '', score: row.selected?.score || '', error: row.error || '' } })), offset, true), count: rows.length, revision: job.revision };
    }

};
