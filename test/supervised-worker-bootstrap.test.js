const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");

async function startWorker(t, identityField) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-worker-expiry-"));
  const entryPath = path.join(root, "main.cjs");
  fs.writeFileSync(
    entryPath,
    `let calls = 0;
module.exports = { handleRequest() { return { calls: ++calls }; } };\n`,
  );
  const config = Buffer.from(
    JSON.stringify({
      identityField,
      [identityField]: "example.worker",
      entryPath,
      provides: ["test.echo.v1"],
      consumes: [],
    }),
  ).toString("base64url");
  const worker = fork(
    path.join(__dirname, "../src/capabilities/supervised-runtime/runtime/worker-bootstrap.js"),
    [`--ravelink-workload-config=${config}`],
    { execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [hello] = await once(worker, "message");
  assert.equal(hello.type, "hello");
  const ready = once(worker, "message");
  worker.send({
    protocolVersion: 1,
    type: "ready",
    sentAt: Date.now(),
    payload: { phase: "authorize" },
  });
  assert.equal((await ready)[0].payload.ok, true);
  return worker;
}

for (const identityField of ["featureId", "modId"]) {
  test(
    `${identityField} worker survives a request expired in transit without dispatching it`,
    { timeout: 10000 },
    async (t) => {
      const worker = await startWorker(t, identityField);
      const request = {
        protocolVersion: 1,
        type: "request",
        sentAt: Date.now(),
        id: "expired",
        capability: "test.echo.v1",
        method: "echo",
        deadlineAt: Date.now() - 1,
        payload: null,
      };
      const timedOut = once(worker, "message");
      worker.send(request);
      const [reply] = await timedOut;
      assert.equal(reply.replyTo, "expired");
      assert.equal(reply.ok, false);
      assert.equal(reply.error.code, "broker_timeout");
      assert.equal(reply.error.retryable, true);
      const successful = once(worker, "message");
      worker.send({ ...request, id: "valid", sentAt: Date.now(), deadlineAt: Date.now() + 5000 });
      const [next] = await successful;
      assert.equal(next.replyTo, "valid");
      assert.deepEqual(next.payload, { calls: 1 });
      assert.equal(worker.connected, true);
    },
  );

  test(
    `${identityField} worker still rejects malformed expired requests with a failing exit code`,
    { timeout: 10000 },
    async (t) => {
      const worker = await startWorker(t, identityField);
      const exited = once(worker, "exit");
      worker.send({
        protocolVersion: 1,
        type: "request",
        sentAt: Date.now(),
        id: "expired",
        capability: "test.echo.v1",
        method: "echo",
        deadlineAt: Date.now() - 1,
        payload: null,
        unexpected: true,
      });
      assert.equal((await exited)[0], 3);
    },
  );
}
