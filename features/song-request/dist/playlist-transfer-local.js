module.exports = async ({ job, rows, library, options, saveLibrary, save }) => {
  const target = job.target || 'tidal';
  if (!['youtube', 'soundcloud', 'tidal'].includes(target) || rows.some(row => row.selected && row.selected.provider !== target)) throw new Error('transfer_review_required');
  const groups = require('./playlist-transfer-plan')(rows, options);
  if (!groups.length) throw new Error('transfer_review_required');
  const status = library.status();
  if (status.collections.filter(row => !row.purpose).length + groups.length > status.limits.collections) throw new Error('playlist_collection_limit');
  const created = [];
  try {
    for (const group of groups) {
      const result = library.create({ name: group.name, provider: target });
      if (!result.ok) throw new Error(result.code);
      created.push(result.collection.id);
      const replaced = library.replace(result.collection.id, group.tracks);
      if (!replaced.ok) throw new Error(replaced.code);
    }
    await saveLibrary();
  } catch (error) { for (const id of created) library.remove(id); throw error; }
  job.localDestinations = groups.map((group, index) => ({ id: created[index], name: group.name, count: group.ids.length }));
  job.state = 'complete'; job.targetLocked = true; job.written = groups.reduce((sum, group) => sum + group.ids.length, 0);
  await save();
};
