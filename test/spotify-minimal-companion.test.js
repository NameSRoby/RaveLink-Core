const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { transform } = require('../integrations/spotify-desktop/vendor/spicetify/platform-hook.cjs');
const createFacade = require('../integrations/spotify-desktop/native-facade.cjs');
const install = require('../integrations/spotify-desktop/renderer-bootstrap.cjs');
const A = 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA';
const source = 'const build="test";function registerFactory(){};registerFactory();const platform={version:build,getPlayerAPI:()=>native};globalThis.originalPlatform=platform;';

test('reduced platform hook preserves Spotify assignments and refuses unsupported, duplicate or foreign hooks', () => {
  const patched = transform(source);assert.equal(patched.ok, true);assert.equal(patched.platformHooks, 1);
  const noRuntime = vm.createContext({ native: {} });vm.runInContext(patched.code, noRuntime);
  assert.equal(noRuntime.originalPlatform.version, 'test', 'absent bootstrap must not break native initialization');
  for (const [input, error] of [['const unrelated=1;', 'spotify_platform_hook_unavailable'], [source + source, 'spotify_platform_hook_ambiguous'], [patched.code, 'spotify_asset_already_patched'], [source + ';Spicetify._platform={};', 'spotify_foreign_companion_detected']]) {
    const rejected = transform(input);assert.equal(rejected.ok, false);assert.equal(rejected.error, error);assert.equal(rejected.code, input);
  }
});

test('standalone renderer captures the private player without loading Spicetify or exposing account/platform data', () => {
  const native = { _queue: { _state: { nextTracks: [] } }, accountSecret: 'private-token' };
  const root = {}, clients = [];
  const status = install(root, { onReady: client => clients.push(client) });
  const context = vm.createContext({ native, __ravelinkSpotify: root.__ravelinkSpotify });
  vm.runInContext(transform(source).code, context);
  assert.equal(status.status().captured, true);assert.equal(status.status().queueReadable, true);assert.equal(clients.length, 1);
  assert.equal(root.Spicetify, undefined);assert.equal(root.__ravelinkSpotify.capturePlatform, undefined);
  assert.equal(root.__ravelinkSpotify.platform, undefined);assert.equal(root.__ravelinkSpotify.Player, undefined);
  assert.equal(JSON.stringify(status.status()).includes('private-token'), false);
  root.__ravelinkSpotify.capturePlatform = { getPlayerAPI() { throw Error('Replacement must be ignored'); } };
  assert.equal(clients.length, 1);assert.throws(() => install(root), /already_installed/);
});

test('minimal native facade supports occurrence-specific operations and lookup without a generic authenticated proxy', async () => {
  const writes = [], reads = [], state = { nextTracks: [{ uri: A, uid: 'one', provider: 'queue' }] };
  const native = { _queue: { _state: state, addToQueue: rows => { writes.push(rows); }, removeFromQueue: rows => { writes.push(rows); } }, _cosmos: { get: url => { reads.push(url);return { tracks: { items: [] } }; } } };
  const facade = createFacade({ getPlayerAPI: () => native });
  await facade.addToQueue([{ uri: A }]);await facade.removeFromQueue([{ uri: A, uid: 'one' }]);
  assert.equal(writes.length, 2);assert.equal(writes[1][0].uid, 'one');
  assert.throws(() => facade.removeFromQueue([{ uri: A }]), /entry_id_required/);
  const valid = 'https://api.spotify.com/v1/search?' + new URLSearchParams({ q: 'Artist and title', type: 'track', limit: '10' });
  await facade.CosmosAsync.get(valid);assert.equal(reads.length, 1);
  for (const url of ['https://example.com/private', 'https://api.spotify.com/v1/me', 'sp://account', valid + '&q=second-query']) await assert.rejects(facade.CosmosAsync.get(url), /lookup_route_invalid/);
  assert.equal(reads.length, 1);assert.equal(facade.CosmosAsync.post, undefined);
  const legacy = createFacade({ PlayerAPI: { _queue: { _queue: state } } });assert.equal(legacy.Queue, state);
});

test('native playback progress continues past fifteen seconds, freezes on pause/buffering and uses direct transport methods', () => {
  let actions = 0;
  const state = { isPaused: false, isBuffering: false, positionAsOfTimestamp: 10000, timestamp: Date.now() - 45000, duration: 180000 };
  const facade = createFacade({ PlayerAPI: { _state: state, pause() { actions++; }, resume() { actions++; }, skipToNext() { actions++; } } });
  assert.ok(facade.Player.getProgress() >= 55000 && facade.Player.getProgress() < 56000);
  state.isPaused = true;assert.equal(facade.Player.getProgress(), 10000);assert.equal(facade.Player.isPlaying(), false);
  state.isPaused = false;state.isBuffering = true;assert.equal(facade.Player.getProgress(), 10000);
  facade.Player.pause();facade.Player.play();facade.Player.next();assert.equal(actions, 3);
  state.positionAsOfTimestamp = Infinity;assert.equal(facade.Player.getProgress(), 0);
});

test('minimal companion bundle is deterministic, contains licenses and can be rebuilt from its included sources', t => {
  execFileSync(process.execPath, ['scripts/build-spotify-desktop.js', '--check']);
  const bundle = path.join(__dirname, '../integrations/spotify-desktop/dist'), manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'integrity.json')));
  assert.equal(manifest.installable, false);
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle, file))).digest('hex'), hash, file);
  assert.match(fs.readFileSync(path.join(bundle, 'LICENSE.Spicetify'), 'utf8'), /GNU LESSER GENERAL PUBLIC LICENSE/);
  const renderer = fs.readFileSync(path.join(bundle, 'renderer.js'), 'utf8');
  assert.ok(Buffer.byteLength(renderer) < 32768);
  for (const excluded of ['window.Spicetify', 'cors-proxy.spicetify.app', 'Marketplace', 'MutationObserver', 'createReactComponents']) assert.equal(renderer.includes(excluded), false, excluded);
  const context = vm.createContext({});vm.runInContext(renderer, context);
  assert.equal(context.__ravelinkSpotify.status().captured, false);assert.equal(context.Spicetify, undefined);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ravelink-spotify-bundle-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.cpSync(bundle, temporary, { recursive: true });
  execFileSync(process.execPath, [path.join(temporary, 'build-spotify-desktop.js')], { cwd: temporary });
  assert.equal(fs.readFileSync(path.join(temporary, 'renderer.js'), 'utf8'), renderer);
});


test('Spotify cover metadata survives the native snapshot, host sanitizer and observed playback path', () => {
  const hash = 'a'.repeat(40), url = 'https://i.scdn.co/image/' + hash;
  const metadata = { title: 'Track', album_title: 'Album', image_xlarge_url: 'spotify:image:' + hash };
  const native = { _state: { isPaused: true, item: { uri: A, uid: 'current', metadata } }, _queue: { _state: { nextTracks: [], track: { uri: A, uid: 'current' } } } };
  const snapshot = createFacade({ PlayerAPI: native }).snapshot();assert.equal(snapshot.current.artworkUrl, url);
  const cleaned = require('../integrations/spotify-desktop/live-state.cjs')(snapshot);assert.equal(cleaned.current.artworkUrl, url);
  const queue = require('../features/song-request/dist/domain').createSongQueue();queue.configurePlaybackSource({ source: 'spotify' });
  assert.equal(queue.observe({ ...cleaned.current, provider: 'spotify', sourceId: 'fixture', status: 'paused' }).ok, true);
  assert.equal(queue.playbackStatus().primary.artworkUrl, url);
  const artwork = require('../integrations/spotify-desktop/catalog.cjs').artworkUrl;
  for (const invalid of ['https://example.com/image/' + hash, url + '?token=secret', 'https://i.scdn.co.evil/image/' + hash, 'javascript:alert(1)']) assert.equal(artwork(invalid), '');
  metadata.image_xlarge_url = 'https://example.com/private';assert.equal(createFacade({ PlayerAPI: native }).snapshot().current.artworkUrl, '');
});
