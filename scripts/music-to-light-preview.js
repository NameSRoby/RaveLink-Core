/** Explicit capture -> artistic preview, with no fixture/output capability.
 * Source identity remains a separate transient CLI argument, never a design field.
 */
const fs = require("node:fs");
const { capture } = require("../integrations/music-to-light/probe.cjs");
const createSession = require("../integrations/music-to-light/session.cjs");
const { settings, fault } = require("../integrations/music-to-light/mapping-settings.cjs");
async function main(args) {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log(
      "Preview only; never controls lights.\nList sources: node scripts/music-to-light-probe.js --list\nPreview: node scripts/music-to-light-preview.js --source <exact-source-id> --seconds 15 [--preset ambient|pulse|bands] [--intensity 0.6]\nAdvanced portable design: --design <settings.json>\nStop: Ctrl+C. No audio or source identity is saved.",
    );
    return;
  }
  if (args.length % 2) throw fault("invalid_preview_arguments");
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--source", "--seconds", "--preset", "--intensity", "--design"].includes(args[i]) ||
      options.has(args[i])
    )
      throw fault("invalid_preview_arguments");
    options.set(args[i], args[i + 1]);
  }
  if (!options.has("--source") || !options.has("--seconds"))
    throw fault("explicit_preview_source_required");
  let design = {};
  if (options.has("--design")) {
    const path = options.get("--design");
    if (!fs.statSync(path).isFile() || fs.statSync(path).size > 16384)
      throw fault("invalid_music_design_file");
    design = settings(JSON.parse(fs.readFileSync(path, "utf8")));
  }
  if (options.has("--preset")) design = { ...design, preset: options.get("--preset") };
  if (options.has("--intensity"))
    design = { ...design, intensity: Number(options.get("--intensity")) };
  const config = settings(design);
  // Validate artistic settings before starting any capture. No output argument is
  // supported: granting physical fixtures belongs to a later reviewed Core host.
  const renderer = createSession({
    settings: config,
    onFrame: (frame) => console.log(JSON.stringify(frame)),
  });
  const probe = capture(options.get("--source"), { seconds: Number(options.get("--seconds")) });
  const stop = () => {
    void renderer.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    renderer.start(probe);
    const result = await renderer.done;
    console.log(
      JSON.stringify({
        state: result.state,
        reason: result.reason,
        frames: result.frames,
        output: result.output,
      }),
    );
    if (result.state === "failed") process.exitCode = 1;
  } finally {
    await renderer.stop();
    probe.stop();
    await probe.done.catch(() => {});
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.code || "music_preview_failed");
    process.exitCode = 1;
  });
module.exports = { main };
