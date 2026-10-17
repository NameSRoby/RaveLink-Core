const test = require("node:test");
const assert = require("node:assert/strict");
const local = require("../src/capabilities/feature-platform/http/local-oauth-callback");

test("OAuth callbacks admit canonical loopback navigations and reject remote or misleading hosts", () => {
  for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.0.2.1"]) {
    for (const host of [
      "127.0.0.1:5050",
      "localhost:5050",
      "untrusted.invalid:5050",
      "127.0.0.1:5051",
    ]) {
      const headers = {};
      let status = 200,
        passed = false;
      const response = {
        setHeader(key, value) {
          headers[key] = value;
        },
        status(value) {
          status = value;
          return this;
        },
        send() {},
      };
      local(
        {
          socket: { remoteAddress: remote, localPort: 5050 },
          headers: { host, origin: "https://accounts.example" },
        },
        response,
        () => {
          passed = true;
        },
      );
      const allowed = remote !== "192.0.2.1" && host === "127.0.0.1:5050";
      assert.equal(passed, allowed, `${remote} ${host}`);
      assert.equal(status, allowed ? 200 : 403);
      assert.equal(headers["Cache-Control"], "no-store");
      assert.equal(headers["Referrer-Policy"], "no-referrer");
      assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
    }
  }
});
