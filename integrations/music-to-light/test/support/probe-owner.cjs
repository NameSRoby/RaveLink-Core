const { spawn } = require("node:child_process");
const { capture, identify } = require("../../probe.cjs");
(async () => {
  const own = await identify(process.pid);
  let helperPid;
  const session = capture(own.id, {
    seconds: 3,
    spawn: (file, args, options) => {
      const child = spawn(file, args, options);
      helperPid = child.pid;
      return child;
    },
  });
  session.events.on("update", (event) => {
    if (event.type === "ready") process.send({ helperPid });
  });
  await session.done;
})().catch(() => {
  process.exitCode = 1;
});
