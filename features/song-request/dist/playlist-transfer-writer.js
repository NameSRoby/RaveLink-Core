const plan = require('./playlist-transfer-plan');
module.exports = function writer({ provider, save, get }) {
  const current = (job, rows) => plan(rows, job)[job.groupIndex || 0];
  const marker = job => 'Created by RaveLink transfer ' + job.id + (job.groupBy && job.groupBy !== 'single' ? ' group ' + (job.groupIndex || 0) : '');
  const key = job => job.id + (job.groupBy && job.groupBy !== 'single' ? '-g' + (job.groupIndex || 0) : '');
  async function readAll(id) {
    const tracks = []; let cursor = '', pages = 0;
    do {
      const result = await provider({ action: 'read', id, cursor });
      if (!result.ok) throw new Error(result.error);
      if (result.tracks.some(row => !row) || ++pages > 1000 || tracks.length + result.tracks.length > 10000) throw new Error('tidal_playlist_reconcile_required');
      tracks.push(...result.tracks); cursor = result.cursor;
    } while (cursor);
    return tracks.map(row => row.providerItemId);
  }
  return {
    async step() {
      const { job, rows } = get(), group = current(job, rows), selected = group.ids;
      if (!job.destinationId) {
        job.intent = 'create'; await save();
        const reply = await provider({ action: 'create', name: group.name, description: marker(job), key: key(job) + '-create' });
        if (!reply.ok) { if (reply.safeToRetry) job.intent = ''; throw new Error(reply.error); }
        job.destinationId = reply.id; job.intent = ''; await save();
      }
      if (job.written < selected.length) {
        job.intent = 'append'; await save();
        const result = await provider({ action: 'append', id: job.destinationId, ids: selected.slice(job.written, job.written + 50), key: key(job) + '-' + job.written });
        if (!result.ok) { if (result.safeToRetry) job.intent = ''; throw new Error(result.error); }
        job.written = Math.min(selected.length, job.written + 50); job.intent = ''; await save();
      } else {
        const actual = await readAll(job.destinationId);
        if (JSON.stringify(actual) !== JSON.stringify(selected)) throw new Error('tidal_playlist_reconcile_required');
        job.destinations = job.destinations || []; job.destinations.push({ id: job.destinationId, name: group.name, count: selected.length });
        if ((job.groupIndex || 0) + 1 < plan(rows, job).length) { job.completedWritten = (job.completedWritten || 0) + job.written; job.groupIndex = (job.groupIndex || 0) + 1; job.destinationId = ''; job.written = 0; }
        else { job.state = 'complete'; job.verified = true; }
        await save();
      }
    },
    async reconcile() {
      const { job, rows } = get();
      if (!job.destinationId) {
        let cursor = '', found = [], pages = 0;
        do { const reply = await provider({ action: 'list', cursor }); if (!reply.ok) throw new Error(reply.error); found.push(...reply.playlists.filter(row => row.description === marker(job))); cursor = reply.cursor; if (++pages > 100) throw new Error('tidal_playlist_reconcile_required'); } while (cursor);
        if (!found.length) { job.intent = ''; job.state = 'paused'; job.resumeState = 'writing'; job.error = ''; await save(); return; }
        if (found.length !== 1) throw new Error('tidal_playlist_create_review_required');
        job.destinationId = found[0].id;
      }
      const actual = await readAll(job.destinationId), expected = current(job, rows).ids;
      if (actual.length > expected.length || actual.some((value, index) => value !== expected[index])) throw new Error('tidal_playlist_reconcile_required');
      if (actual.length !== job.written && actual.length !== Math.min(expected.length, job.written + 50)) throw new Error('tidal_playlist_reconcile_required');
      job.written = actual.length; job.intent = ''; job.state = 'paused'; job.error = ''; await save();
    }
  };
};
