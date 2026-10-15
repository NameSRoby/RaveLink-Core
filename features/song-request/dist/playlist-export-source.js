module.exports = ({ library, job, rows, input }) => {
  if (input.collectionId) {
    const collection = library.get(input.collectionId);
    if (!collection) throw new Error('playlist_not_found');
    return { name: collection.name, tracks: collection.tracks, revision: collection.updatedAt };
  }
  if (!job || input.jobId !== job.id) throw new Error('transfer_changed');
  if (['reading', 'matching', 'writing', 'uncertain'].includes(job.state)) throw new Error('transfer_busy');
  return { name: job.name, tracks: rows.filter(row => row.track && row.include !== false).map(row => row.track), revision: job.revision };
};
