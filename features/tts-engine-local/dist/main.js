const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ENGINE_NAME = "RaveLink Local TTS", ENGINE_VERSION = "1.0.0", PAYLOAD_ID = "tts-voice-kitten-en", MAX_QUEUE = 10;
const VOICES = Object.freeze(["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"].map((name, sid) => Object.freeze({ id: `kitten-en-${sid}`, name: `${name} (English)`, language: "en-US", isDefault: sid === 0, sid })));
const PLAYER_SCRIPT = "$i=[Console]::OpenStandardInput();$m=New-Object IO.MemoryStream;$i.CopyTo($m);$m.Position=0;$p=New-Object Media.SoundPlayer($m);$p.PlaySync();$p.Dispose();$m.Dispose()";
let context, assetsRoot = "", enginePromise = null, current = null, player = null, pumping = false, active = false;
const queue = [];

function payloadRoot() { return path.join(assetsRoot, PAYLOAD_ID); }
function payloadReady() {
  const root = payloadRoot();
  try {
    const descriptor = JSON.parse(fs.readFileSync(path.join(root, "ravelink.tts-payload.json"), "utf8"));
    return descriptor?.schemaVersion === 1 && descriptor.id === PAYLOAD_ID && descriptor.version === "1.0.0"
      && fs.statSync(path.join(root, "runtime", "sherpa-onnx-node", "addon.js")).isFile()
      && fs.statSync(path.join(root, "model", "model.fp16.onnx")).isFile();
  } catch { return false; }
}
function emit(event, task, code = "") { try { context?.publishEvent("alerts.tts.events.v1", event, { utteranceId: task.id, code }); } catch {} }

async function loadEngine() {
  if (!payloadReady()) throw new Error("tts_voice_unavailable");
  if (!enginePromise) enginePromise = (async () => {
    const root = payloadRoot(), sherpa = require(path.join(root, "runtime", "sherpa-onnx-node")), model = path.join(root, "model");
    const tts = await sherpa.OfflineTts.createAsync({
      model: { kitten: { model: path.join(model, "model.fp16.onnx"), voices: path.join(model, "voices.bin"), tokens: path.join(model, "tokens.txt"), dataDir: path.join(model, "espeak-ng-data"), lengthScale: 1 }},
      numThreads: 1, debug: 0, provider: "cpu", maxNumSentences: 1
    });
    return { sherpa, tts };
  })().catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

function wavBuffer(samples, sampleRate, volume) {
  const count = Math.min(samples.length, sampleRate * 30), output = Buffer.allocUnsafe(44 + count * 2), gain = Math.max(0, Math.min(1, volume / 100));
  output.write("RIFF", 0); output.writeUInt32LE(36 + count * 2, 4); output.write("WAVEfmt ", 8); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write("data", 36); output.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index += 1) output.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Number(samples[index]) || 0)) * gain * 32767), 44 + index * 2);
  return output;
}
function playWav(buffer, task) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PLAYER_SCRIPT], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"], shell: false });
    player = child; child.once("error", reject); child.once("exit", code => code === 0 || task.canceled ? resolve() : reject(new Error("tts_audio_output_failed")));
    child.stdin.on("error", error => { if (!task.canceled) reject(error); }); child.stdin.end(buffer);
  }).finally(() => { player = null; });
}
async function run(task) {
  current = task; emit("started", task);
  try {
    const { sherpa, tts } = await loadEngine(), voice = VOICES.find(row => row.id === task.voiceId) || VOICES[0];
    const audio = await tts.generateAsync({ text: task.text, generationConfig: new sherpa.GenerationConfig({ sid: voice.sid, speed: task.rate, silenceScale: 0.2 }), onProgress: () => !task.canceled });
    if (task.canceled) { emit("canceled", task, "tts_canceled"); return; }
    await playWav(wavBuffer(audio.samples, audio.sampleRate, task.volume), task);
    emit(task.canceled ? "canceled" : "completed", task, task.canceled ? "tts_canceled" : "tts_completed");
  } catch (error) { emit(task.canceled ? "canceled" : "failed", task, task.canceled ? "tts_canceled" : String(error?.message || "tts_failed").slice(0, 80)); }
  finally { current = null; }
}
async function pump() { if (pumping) return; pumping = true; try { while (active && queue.length) await run(queue.shift()); } finally { pumping = false; } }
function cancelAll() {
  let canceled = queue.length; for (const task of queue.splice(0)) { task.canceled = true; emit("canceled", task, "tts_canceled"); }
  if (current) { current.canceled = true; canceled += 1; } try { player?.kill?.(); } catch {} return canceled;
}
function normalizeTask(payload = {}) {
  const text = String(payload.text || "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return null;
  const requestedVolume = Number(payload.volume), requestedRate = Number(payload.rate);
  return { id: crypto.randomUUID(), text, voiceId: VOICES.some(row => row.id === payload.voiceId) ? payload.voiceId : VOICES[0].id, volume: Math.round(Math.max(0, Math.min(100, Number.isFinite(requestedVolume) ? requestedVolume : 85))), rate: Math.max(0.5, Math.min(2, Number.isFinite(requestedRate) ? requestedRate : 1)), canceled: false };
}
function enqueue(payload = {}) {
  if (!active) return { ok: false, code: "tts_runtime_stopping", utteranceId: "" };
  if (!payloadReady()) return { ok: false, code: "tts_voice_unavailable", utteranceId: "" };
  const task = normalizeTask(payload); if (!task) return { ok: false, code: "tts_text_required", utteranceId: "" };
  const busy = Boolean(current || queue.length);
  if (payload.queuePolicy === "skip-when-busy" && busy) return { ok: false, code: "tts_busy", utteranceId: "" };
  if (payload.queuePolicy === "replace" && busy) cancelAll();
  if (queue.length >= MAX_QUEUE) return { ok: false, code: "tts_queue_full", utteranceId: "" };
  queue.push(task); emit("queued", task); void pump(); return { ok: true, code: "tts_preview_queued", utteranceId: task.id };
}
async function activate(nextContext) { context = nextContext; assetsRoot = path.resolve(String(nextContext?.runtimeAssetsRoot || "")); active = true; }
async function handleRequest(request) {
  if (request.capability === "alerts.tts.catalog.v1" && request.method === "status") { const ready = payloadReady(); return { ok: true, engineName: ENGINE_NAME, engineVersion: ENGINE_VERSION, voices: ready ? VOICES.map(({ sid, ...row }) => row) : [], outputs: [{ id: "default", name: "Windows default output", language: "", isDefault: true }], active: Boolean(current), queued: queue.length }; }
  if (request.capability === "alerts.tts.admin.v1" && request.method === "preview") return enqueue(request.payload);
  if (request.capability === "alerts.tts.queue.v1" && request.method === "enqueue") return enqueue(request.payload);
  if (request.capability === "alerts.tts.admin.v1" && request.method === "cancel-all") { const canceled = cancelAll(); return { ok: true, code: canceled ? "tts_canceled" : "tts_queue_empty" }; }
  throw new Error("method_unavailable");
}
async function deactivate() { active = false; cancelAll(); context = null; }
module.exports = { activate, deactivate, handleRequest, _test: { normalizeTask, wavBuffer } };
