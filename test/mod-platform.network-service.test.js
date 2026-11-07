// [TITLE] Test Module: test/mod-platform.network-service.test.js
// [TITLE] Purpose: verify exact-host HTTPS authorization and bounded concurrency

const test = require("node:test");
const assert = require("node:assert/strict");
const createNetwork = require("../src/capabilities/mod-platform/host/mod-network-service");
const { isPublicAddress, normalizedPath } = createNetwork;

function manifest() {
  return {
    id: "example.net",
    permissions: { network: ["api.example.com:443"] },
    resources: { externalInFlight: 1 },
  };
}

test("network service permits only exact declared targets and strips arbitrary headers", async () => {
  let observed;
  const network = createNetwork({
    transport: async (request) => {
      observed = request;
      return { status: 200, data: { ok: true }, bytes: 11 };
    },
  });
  assert.equal(
    (
      await network.request(manifest(), {
        host: "evil.example.com",
        path: "/x",
      })
    ).error,
    "network_permission_denied",
  );
  const result = await network.request(manifest(), {
    host: "api.example.com:443",
    method: "POST",
    path: "/v1/items?q=1",
    contentType: "application/json",
    headers: { authorization: "must-not-pass" },
    body: { name: "test" },
  });
  assert.equal(result.ok, true);
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.hostname, "api.example.com");
});

test("network service enforces concurrency and validates paths", async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const network = createNetwork({
    transport: async () => {
      await blocker;
      return { status: 204, data: "", bytes: 0 };
    },
  });
  const first = network.request(manifest(), {
    host: "api.example.com:443",
    path: "/one",
  });
  assert.equal(
    (
      await network.request(manifest(), {
        host: "api.example.com:443",
        path: "/two",
      })
    ).error,
    "network_busy",
  );
  release();
  assert.equal((await first).ok, true);
  assert.equal(normalizedPath("https://evil.example/x"), "");
  assert.equal(normalizedPath("/allowed/../escaped"), "");
});

test("network address policy rejects local, private, link-local, multicast, and documentation ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("network service routes brokered HTTPS through optional shared admission", async () => {
  let admission;
  const network = createNetwork({
    egressGovernor: {
      run: async (spec, operation) => {
        admission = spec;
        return operation();
      },
    },
    transport: async () => ({ status: 200, data: null, bytes: 0 }),
  });
  assert.equal(
    (
      await network.request(manifest(), {
        host: "api.example.com:443",
        path: "/status",
      })
    ).ok,
    true,
  );
  assert.deepEqual(admission, {
    owner: "mod.network",
    priority: "optional",
    queueDeadlineMs: 8000,
  });
});
