const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { verifyFeaturePackageDirectory } = require("../src/capabilities/feature-platform/packages/feature-package-integrity");
const { compileFeatureContracts } = require("../src/capabilities/feature-platform/contracts/data-contract-compiler");
const { createFeatureRuntimeHarness } = require("./support/feature-runtime-harness");
const feature = require("../features/tts-engine-local/dist/main");

const root = path.join(__dirname, "..", "features", "tts-engine-local");

test("Local TTS Engine foundation is a verified remote-only package with narrow authority", async () => {
  const verified = await verifyFeaturePackageDirectory(root);
  assert.equal(verified.ok, true);
  assert.equal(verified.manifest.id, "tts-engine-local");
  assert.deepEqual(verified.manifest.permissions, { network: [], storage: false, secrets: [], process: true, nativeAddons: true, hardware: [] });
  const compiled = await compileFeatureContracts(root, verified.manifest);
  assert.equal(compiled.ok, true);
  assert.deepEqual([...compiled.contracts.keys()], ["alerts.tts.catalog.v1", "alerts.tts.admin.v1", "alerts.tts.queue.v1", "alerts.tts.events.v1"]);
});

test("Local TTS Engine creates bounded PCM WAV data and normalizes queued speech", () => {
  const task = feature._test.normalizeTask({ text: "  Hello\u0000   world  ", voiceId: "unknown", volume: 150, rate: 9 });
  assert.equal(task.text, "Hello world");
  assert.equal(task.voiceId, "kitten-en-0");
  assert.equal(task.volume, 100);
  assert.equal(task.rate, 2);
  const wav = feature._test.wavBuffer(new Float32Array([0, 1, -1]), 24000, 50);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.length, 50);
});

test("Local TTS Engine foundation reports missing voices and never pretends to synthesize", async t => {
  const harness = createFeatureRuntimeHarness(feature, { featureId: "tts-engine-local", providers: {} });
  await harness.start();
  t.after(() => harness.stop());
  const status = await harness.request("alerts.tts.catalog.v1", "status", {});
  assert.equal(status.ok, true);
  assert.equal(status.engineName, "RaveLink Local TTS");
  assert.deepEqual(status.voices, []);
  assert.equal(status.active, false);
  const preview = await harness.request("alerts.tts.admin.v1", "preview", {
    text: "Local preview", version: 1, voiceId: "", outputId: "default",
    volume: 85, rate: 1, pitch: 1, queuePolicy: "queue"
  });
  assert.deepEqual(preview, { ok: false, code: "tts_voice_unavailable", utteranceId: "" });
  assert.deepEqual(await harness.request("alerts.tts.admin.v1", "cancel-all", {}), { ok: true, code: "tts_queue_empty" });
});
