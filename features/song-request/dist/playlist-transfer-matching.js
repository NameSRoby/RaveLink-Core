const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const editions = value => normalize(value).match(/\b(live|remix|remaster|acoustic|instrumental|karaoke|cover|sped|slowed)\b/g) || [];
function rank(source, candidates) {
  const title = normalize(source.title), artists = normalize(source.artists.join(' '));
  return candidates.slice(0, 10).map(candidate => {
    const tokens = new Set(normalize(candidate.title).split(' ')), wanted = title.split(' ');
    const titleScore = wanted.filter(value => tokens.has(value)).length / Math.max(wanted.length, tokens.size, 1);
    const artist = normalize(candidate.artists.join(' '));
    const artistScore = artists && (artist === artists || artist.includes(artists) || artists.includes(artist)) ? 1 : 0;
    const durationScore = source.durationMs && candidate.durationMs ? Math.max(0, 1 - Math.abs(candidate.durationMs - source.durationMs) / 10000) : 0.5;
    const versionMatch = JSON.stringify(editions(source.title + ' ' + source.version).sort()) === JSON.stringify(editions(candidate.title + ' ' + candidate.version).sort());
    const isrcMatch = source.isrc && source.isrc === candidate.isrc;
    const adaptiveScore = candidate.provider === 'soundcloud' && Number.isFinite(candidate.matchConfidence) ? Math.min(100, candidate.matchConfidence) * 0.85 / 100 + durationScore * 0.15 : 0;
    const score = Math.round(Math.max(adaptiveScore, isrcMatch && durationScore >= 0.8 && artistScore ? 0.99 : 0, titleScore * 0.5 + artistScore * 0.35 + durationScore * 0.15) * (versionMatch ? 100 : 50));
    return { ...compact(candidate), score, autoSelectable: versionMatch, reason: !versionMatch ? 'Different recording version' : isrcMatch ? 'Same ISRC, checked against artist and duration' : artistScore ? 'Title, artist and duration comparison' : 'Artist needs review' };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
}
function compact(candidate) { return { provider: candidate.provider || 'tidal', providerItemId: candidate.providerItemId, title: candidate.title.slice(0, 150), artists: candidate.artists.slice(0, 3).map(value => value.slice(0, 60)), album: String(candidate.album || '').slice(0, 100), version: String(candidate.version || '').slice(0, 60), isrc: String(candidate.isrc || '').slice(0, 20), durationMs: candidate.durationMs || 0, sourceUrl: candidate.sourceUrl || '', artworkUrl: candidate.artworkUrl || '' }; }
module.exports = { rank, compact };
