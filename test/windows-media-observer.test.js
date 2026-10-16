const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const createWindowsMediaObserver = require("../src/capabilities/feature-platform/providers/windows-media-observer");

test('Windows artwork cache refreshes a thumbnail that arrives after the track title', { skip: process.platform !== 'win32' }, () => {
  const path = require('node:path');
  const output = require('node:child_process').execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'support/windows-media-artwork-cache.ps1'),
    '-ObserverPath', path.join(__dirname, '../scripts/windows-media-observer.ps1')
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.match(output, /Artwork cache transition checks passed/);
});

function fakeProcess(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", 0));
    return true;
  };
  return child;
}

test("Windows media observer preserves Unicode and can switch providers without restarting RaveLink", async () => {
  const children = [];
  const calls = [];
  const observed = [];
  const observer = createWindowsMediaObserver({
    supported: true,
    provider: "tidal",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = fakeProcess(1000 + children.length);
      children.push(child);
      return child;
    },
    async onSnapshot(snapshot) {
      observed.push(snapshot);
      return { ok: true };
    }
  });

  assert.equal(observer.start().lifecycle, "active");
  assert.deepEqual(calls[0].args.slice(-2), ["-Provider", "tidal"]);
  assert.equal(calls[0].options.windowsHide, true);
  children[0].stdout.write(`${JSON.stringify({ schemaVersion: 2, available: true, source: "TIDAL.Desktop", title: "美波 - カワキヲアメク", artist: "美波", album: "カワキヲアメク", status: "Playing", positionMs: 1234, durationMs: 250000, observedAt: 123456 })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed[0].title, "美波 - カワキヲアメク");
  assert.deepEqual(observed[0].artists, ["美波"]);

  const switched = await observer.control({ action: "select", provider: "spotify" });
  assert.equal(switched.lifecycle, "active");
  assert.equal(switched.selectedProvider, "spotify");
  assert.deepEqual(calls[1].args.slice(-2), ["-Provider", "spotify"]);
  await observer.stop();
  assert.equal(observer.status().lifecycle, "stopped");
});

test("Windows media observer rejects mismatched source applications and unsupported providers", async () => {
  const child = fakeProcess(2000);
  const observed = [];
  const observer = createWindowsMediaObserver({
    supported: true,
    provider: "spotify",
    spawn: () => child,
    onSnapshot: async snapshot => { observed.push(snapshot); return { ok: true }; }
  });
  observer.start();
  child.stdout.write(`${JSON.stringify({ schemaVersion: 2, available: true, source: "Unrelated.Player", title: "Wrong source" })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 0);
  assert.equal(observer.status().counters.malformed, 1);
  assert.equal((await observer.control({ action: "select", provider: "unknown" })).error, "media_provider_invalid");
  await observer.stop();
});

test('Windows artwork is bounded local JPEG data and survives into the selected playback card', () => {
  const normalize = createWindowsMediaObserver.normalizeMediaSnapshot;
  const image = 'data:image/jpeg;base64,/9j/YWJj';
  const snapshot = {schemaVersion:2,available:true,source:'TIDAL.Desktop',title:'Current',artist:'Artist',album:'Album',artworkUrl:image,status:'Paused',durationMs:180000,positionMs:42000};
  const safe = normalize(snapshot, 'tidal'); assert.equal(safe.artworkUrl, image);
  for (const artworkUrl of ['https://untrusted.example/image.jpg','data:image/svg+xml,<svg/>',image+'a'.repeat(12288)]) assert.equal(normalize({...snapshot,artworkUrl},'tidal').artworkUrl, '');
  const queue = require('../features/song-request/dist/domain').createSongQueue();
  queue.configurePlaybackSource({source:'tidal'}); queue.observe(safe);
  const playback = queue.playbackStatus(); assert.equal(playback.primary.artworkUrl, image); assert.equal(playback.primary.album, 'Album');
  assert.equal(playback.observed[0].artworkUrl, undefined, 'large artwork is sent once in primary, not duplicated across observations');
});

test('a corrected cover for the same song is forwarded into playback state', async () => {
  const child = fakeProcess(3000), queue = require('../features/song-request/dist/domain').createSongQueue();
  queue.configurePlaybackSource({source:'tidal'});
  const observer = createWindowsMediaObserver({supported:true,spawn:()=>child,onSnapshot:async snapshot=>queue.observe(snapshot)});
  const snapshot = {schemaVersion:2,available:true,source:'TIDAL.Desktop',title:'New song',artist:'Artist',album:'New album',status:'Playing'};
  observer.start();
  try {
    for (const artworkUrl of ['data:image/jpeg;base64,/9j/YWJj','data:image/jpeg;base64,/9j/ZGVm']) {
      child.stdout.write(JSON.stringify({...snapshot,artworkUrl})+'\n');
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(queue.playbackStatus().primary.artworkUrl,artworkUrl);
      assert.equal(queue.playbackStatus().primary.title,'New song');
    }
  } finally { await observer.stop(); }
});
test('SoundCloud playlist artwork survives portable normalization without accepting arbitrary image hosts', () => {
  const {normalizeTrack} = require('../features/song-request/dist/portable-track');
  const original = {provider:'soundcloud',providerItemId:'293',title:'Track',artworkUrl:'https://i1.sndcdn.com/artworks-test-large.jpg'};
  assert.equal(normalizeTrack(normalizeTrack(original)).candidate.artworkUrl, original.artworkUrl);
  for (const artworkUrl of ['https://i1.sndcdn.com.evil.example/image.jpg','https://user:password@i1.sndcdn.com/image.jpg','data:image/svg+xml,evil']) assert.equal(normalizeTrack({...original,artworkUrl}).candidate.artworkUrl, undefined);
});
