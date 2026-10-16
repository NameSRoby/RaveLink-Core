// Local asset inspection only. Extracted Spotify code must never enter a release bundle.
const vm = require('node:vm');
module.exports = function snapshotSource(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 64 * 1024 * 1024) throw Error('spotify_snapshot_invalid');
  const start = Buffer.from('var __webpack_modules__={', 'utf16le'), end = Buffer.from('xpui-modules.js.map', 'utf16le');
  const at = buffer.indexOf(start), until = at < 0 ? -1 : buffer.indexOf(end, at + start.length);
  if (at < 0 || until < at || until - at > 32 * 1024 * 1024 || (until - at) % 2) throw Error('spotify_snapshot_source_unavailable');
  if (buffer.indexOf(start, at + start.length) >= 0) throw Error('spotify_snapshot_source_ambiguous');
  const text = buffer.subarray(at, until + end.length).toString('utf16le');
  try { new vm.Script(text); } catch { throw Error('spotify_snapshot_source_invalid'); }
  return text;
};
