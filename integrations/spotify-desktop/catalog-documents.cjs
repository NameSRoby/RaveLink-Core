// Read only the operation identifiers/hashes already supplied by this installed
// client. No Spotify executable, proprietary source or account token is shipped.
const { readArchive } = require('./archive.cjs');
module.exports = async function catalogDocuments(archive, snapshot) {
  const sources = (await readArchive(archive)).filter(row => row.name.endsWith('.js')).map(row => row.data.toString('utf8'));
  if (snapshot) sources.push(require('./snapshot-source.cjs')(snapshot));
  const result = {};
  for (const name of ['searchTracks', 'getTrack']) {
    const pattern = new RegExp('new [\\w$.]+\\("' + name + '","query","([a-f0-9]{64})",null\\)', 'g');
    const hashes = new Set(sources.flatMap(source => [...source.matchAll(pattern)].map(match => match[1])));
    if (hashes.size === 1) result[name] = [...hashes][0];
  }
  return result;
};
