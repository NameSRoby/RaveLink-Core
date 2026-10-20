/** Local diagnostic CLI. Requires an explicit capture source copied from --list.
 * Measurements are printed, not saved. No automatic playback/capture/light writes.
 */
const { capture, listSources, identify } = require("../integrations/music-to-light/probe.cjs");
async function main(args) {
  if (args.length === 1 && args[0] === "--list") {
    console.log(JSON.stringify(await listSources(), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === "--identify") {
    console.log(JSON.stringify(await identify(Number(args[1])), null, 2));
    return;
  }
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--seconds") {
    console.log(
      "Build: node scripts/build-music-to-light-probe.js\nList: node scripts/music-to-light-probe.js --list\nCapture: node scripts/music-to-light-probe.js --source <exact-source-id> --seconds 15\nStop: Ctrl+C. This proof emits measurements only; it never records audio or controls lights.",
    );
    if (args.length) process.exitCode = 1;
    return;
  }
  const session = capture(args[1], { seconds: Number(args[3]) });
  const stop = () => session.stop();
  process.on("SIGINT", stop);
  session.events.on("update", (event) => console.log(JSON.stringify(event)));
  try {
    await session.done;
  } finally {
    session.stop();
    process.removeListener("SIGINT", stop);
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(error.code || "audio_probe_failed");
  process.exitCode = 1;
});
