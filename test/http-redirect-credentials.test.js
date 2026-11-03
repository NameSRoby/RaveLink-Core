const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const vm = require("node:vm");
const redirects = require("follow-redirects");

test("cross-realm sensitive header lists still strip custom credentials on a cross-origin redirect", async (t) => {
  const seen = [];
  const destination = http.createServer((request, response) => {
    seen.push(request.headers);
    response.end("fixture");
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listen(destination);
  const origin = http.createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/` });
    response.end();
  });
  t.after(async () => {
    await Promise.all(
      [origin, destination].map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
    );
  });
  await listen(origin);
  for (const sensitiveHeaders of [
    ["X-Fixture-Credential"],
    vm.runInNewContext('["X-Fixture-Credential"]'),
  ]) {
    await new Promise((resolve, reject) => {
      const request = redirects.http.get(
        `http://127.0.0.1:${origin.address().port}/`,
        {
          headers: { "X-Fixture-Credential": "synthetic-test-value", "X-Harmless": "retained" },
          sensitiveHeaders,
        },
        (response) => {
          response.resume();
          response.once("end", resolve);
        },
      );
      request.once("error", reject);
      request.setTimeout(3000, () => request.destroy(new Error("fixture_timeout")));
    });
  }
  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers["x-fixture-credential"], undefined);
    assert.equal(headers["x-harmless"], "retained");
  }
});
