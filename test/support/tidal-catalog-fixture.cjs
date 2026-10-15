module.exports = async function catalogFixture(url, init = {}) {
  const target = new URL(url);
  const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (target.hostname === 'auth.tidal.com') return reply({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer', scope: init.body?.get('scope') || 'search.read', expires_in: 3600 });
  if (target.pathname === '/v2/searchResults') {
    const long = target.searchParams.get('filter[query]').toLowerCase().includes('iron maiden');
    return reply({ data: [{ type: 'searchResults', id: 'opaque-result', relationships: { tracks: { data: [{ type: 'tracks', id: long ? '456' : '123' }] } } }] });
  }
  if (/^\/v2\/tracks\/\d+$/.test(target.pathname)) {
    const id = target.pathname.split('/').pop(), long = id === '456';
    return reply({ data: { type: 'tracks', id, attributes: { title: long ? 'The Book Of Souls' : 'TIDAL UI fixture', duration: long ? 'PT10M27S' : 'PT3M' },
      relationships: { artists: { data: [{ type: 'artists', id: 'artist' }] } } }, included: [{ type: 'artists', id: 'artist', attributes: { name: long ? 'Iron Maiden' : 'Artist' } }] });
  }
  throw new Error('Unexpected catalog endpoint');
};
