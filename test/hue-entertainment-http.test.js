const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/adapters/brands/hue-entertainment-http");
const config = { bridgeIp: "192.0.2.5", username: "private-user" };
const identity = "001788FFFE123456";
test("legacy saved fixtures resolve bridge identity without credentials and verify the peer name over HTTPS", async () => {
  const calls = [];
  const request = create({
    timeoutMs: 9000,
    rootDir: process.cwd(),
    http: {
      request: async (options) => {
        calls.push(options);
        if (options.url.endsWith("/api/config")) {
          assert(!options.headers);
          assert(!options.url.includes(config.username));
          return { data: { bridgeid: identity.toLowerCase() } };
        }
        assert(options.url.startsWith("https://"));
        const tls = options.httpsAgent.options;
        assert.equal(tls.rejectUnauthorized, true);
        assert.equal(tls.servername, identity);
        assert(tls.ca);
        assert.equal(
          tls.checkServerIdentity(config.bridgeIp, { subjectaltname: "DNS:" + identity }),
          undefined,
        );
        assert.equal(
          tls.checkServerIdentity(config.bridgeIp, { subjectaltname: "DNS:001788FFFE999999" }).code,
          "ERR_TLS_CERT_ALTNAME_INVALID",
        );
        assert.equal(options.maxRedirects, 0);
        return { data: { type: "Entertainment" } };
      },
    },
  });
  await request(config, 1, "groups/200");
  await request(config, 1, "groups/200", { stream: { active: true } });
  assert.equal(calls.filter((r) => r.url.endsWith("/api/config")).length, 1);
  assert.equal(calls.filter((r) => r.headers?.["hue-application-key"]).length, 2);
});
test("an existing bridge ID requires no metadata query; invalid or absent identity fails before credentials are sent", async () => {
  let calls = 0;
  const request = create({
    timeoutMs: 9000,
    rootDir: process.cwd(),
    http: {
      request: async (o) => {
        calls++;
        if (o.url.endsWith("/api/config")) return { data: {} };
        return { data: {} };
      },
    },
  });
  await request({ ...config, bridgeId: identity }, 2, "auth/v1");
  assert.equal(calls, 1);
  await assert.rejects(
    request({ ...config, bridgeId: "../../invalid" }, 1, "groups/200"),
    /bridge_identity_missing/,
  );
  assert.equal(calls, 1);
  await assert.rejects(request(config, 1, "groups/200"), /bridge_identity_missing/);
  assert.equal(calls, 2);
});
test("TLS, network and bridge errors become bounded actionable codes without unsafe HTTP fallback", async () => {
  for (const [native, expected] of [
    ["ERR_TLS_CERT_ALTNAME_INVALID", "bridge_identity_mismatch"],
    ["CERT_HAS_EXPIRED", "certificate_failed"],
    ["ECONNABORTED", "bridge_timeout"],
    ["ECONNREFUSED", "bridge_unreachable"],
    ["ERR_CANCELED", "cancelled"],
  ]) {
    let calls = 0;
    const request = create({
      timeoutMs: 9000,
      http: {
        request: async () => {
          calls++;
          throw Object.assign(Error("private bridge URL and credentials"), { code: native });
        },
      },
    });
    await assert.rejects(
      request({ ...config, bridgeId: identity }, 1, "groups/200"),
      (e) => e.code === "hue_entertainment_" + expected && e.message === e.code,
    );
    assert.equal(calls, 1);
  }
});
