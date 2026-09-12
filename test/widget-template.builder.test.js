const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { normalizeWidgetPayload, generateWidgetTemplate } = require("../src/domains/system/widget-template.builder");
const documentedMessage = require("./fixtures/streamelements/message.documented.json");
const documentedFollower = require("./fixtures/streamelements/follower-latest.documented.json");

function loadWidget(payload, fetchImpl) {
  const listeners = new Map();
  const result = generateWidgetTemplate(payload);
  const context = {
    AbortController,
    Date,
    Set,
    Map,
    clearTimeout,
    console: { warn() {} },
    fetch: fetchImpl,
    setTimeout,
    window: { addEventListener(name, handler) { listeners.set(name, handler); } }
  };
  vm.runInNewContext(result.script, context, { timeout: 1000 });
  return { result, runtime: context.window.RaveLinkWidgetRuntime, listeners };
}

function redemption(id = "event-1", rewardId = "reward-color") {
  return {
    detail: {
      listener: "redemption-latest",
      event: { redemption: { id, reward: { id: rewardId }, user_input: "red" } }
    }
  };
}

test("normalization keeps only bounded event-forwarding configuration", () => {
  assert.deepEqual(normalizeWidgetPayload({
    baseUrl: "http://127.0.0.1:5050/",
    colorRewardId: " color ",
    twitchUserAccessToken: "must-not-survive",
    streamElementsBotJwt: "must-not-survive"
  }), {
    colorRewardId: "color",
    teachRewardId: "",
    songRewardId: "",
    baseUrl: "http://127.0.0.1:5050",
    widgetIntakeToken: ""
  });
});

test("normalization bounds the base URL before removing trailing slashes", () => {
  assert.equal(
    normalizeWidgetPayload({ baseUrl: `http://127.0.0.1:5050${"/".repeat(10000)}` }).baseUrl,
    "http://127.0.0.1:5050"
  );
});

test("generated widget contains no OAuth, bot, or direct light policy", () => {
  const result = generateWidgetTemplate({
    twitchUserAccessToken: "oauth-secret",
    streamElementsBotJwt: "bot-secret",
    streamElementsBotChannelId: "channel-secret"
  });
  for (const forbidden of ["oauth-secret", "bot-secret", "channel-secret", "api.streamelements.com", "api.twitch.tv", "id.twitch.tv", "helix", "/color", "/teach", "/rave/"]) {
    assert.equal(result.script.includes(forbidden), false, `widget contains ${forbidden}`);
  }
  assert.deepEqual(result.warnings.map(row => row.code), ["widget_credentials_ignored", "widget_intake_token_missing"]);
});

test("widget forwards a configured redemption with its scoped intake token", async () => {
  const calls = [];
  const { runtime, listeners } = loadWidget({
    baseUrl: "http://127.0.0.1:5050",
    colorRewardId: "reward-color",
    widgetIntakeToken: "intake-token"
  }, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  });
  assert.equal(typeof listeners.get("onEventReceived"), "function");
  await runtime.forward(redemption());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:5050/widget/events");
  assert.equal(calls[0].options.headers.Authorization, "Bearer intake-token");
  assert.equal(JSON.parse(calls[0].options.body).contract, "widget.events.v2");
  assert.equal(JSON.parse(calls[0].options.body).eventEnvelope.detail.event.user_input, "red");
});

test("widget reports an authenticated deployment heartbeat without forwarding load secrets", async () => {
  const calls = [];
  const { listeners } = loadWidget({ widgetIntakeToken: "intake-token" }, async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  });
  listeners.get("onWidgetLoad")({ detail: { channel: { apiToken: "must-not-forward" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventEnvelope.detail.listener, "ravelink-widget-ready");
  assert.equal(JSON.stringify(calls[0]).includes("must-not-forward"), false);
});

test("widget ignores unrelated events and duplicate redemption IDs", async () => {
  const calls = [];
  const { runtime } = loadWidget({ colorRewardId: "reward-color" }, async () => {
    calls.push(true);
    return { ok: true, status: 200 };
  });
  await runtime.forward({ detail: { listener: "message", event: { text: "hello" } } });
  await runtime.forward(redemption("other", "other-reward"));
  await runtime.forward(redemption("same"));
  await runtime.forward(redemption("same"));
  assert.equal(calls.length, 1);
});

test("widget ignores documented StreamElements message and latest-event envelopes", async () => {
  const calls = [];
  const { runtime } = loadWidget({ colorRewardId: "reward-color" }, async url => {
    calls.push(url);
    return { ok: true, status: 200 };
  });
  assert.equal(runtime.isRelevant(documentedMessage), false);
  assert.equal(runtime.isRelevant(documentedFollower), false);
  await runtime.forward(documentedMessage);
  await runtime.forward(documentedFollower);
  assert.deepEqual(calls, []);
});

test("widget bounds forwarding to one in-flight request", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { runtime } = loadWidget({ colorRewardId: "reward-color" }, async () => {
    calls.push(true);
    await pending;
    return { ok: true, status: 200 };
  });
  const first = runtime.forward(redemption("first"));
  const second = await runtime.forward(redemption("second"));
  assert.equal(second.skipped, true);
  assert.equal(calls.length, 1);
  release();
  await first;
});

test("widget aborts a hung forward and accepts the next redemption", async () => {
  let calls = 0;
  const { runtime } = loadWidget({ colorRewardId: "reward-color" }, async (url, options) => {
    calls += 1;
    if (calls > 1) return { ok: true, status: 200 };
    return await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const startedAt = Date.now();
  const timedOut = await runtime.forward(redemption("hung"));
  assert.equal(timedOut.outcome, "server_unavailable");
  assert.ok(Date.now() - startedAt >= 3000);
  const recovered = await runtime.forward(redemption("after-timeout"));
  assert.equal(recovered.ok, true);
  assert.equal(calls, 2);
});

test("widget transport treats every HTTP failure as terminal without a weaker fallback", async () => {
  for (const [status, outcome] of [[401, "authentication_rejected"], [403, "authentication_rejected"], [404, "contract_unavailable"], [429, "rate_limited"], [503, "server_unavailable"]]) {
    const calls = [];
    const { runtime } = loadWidget({ colorRewardId: "reward-color" }, async url => {
      calls.push(url);
      return { ok: false, status };
    });
    const result = await runtime.forward(redemption(`status-${status}`));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, status, outcome, terminal: true });
    assert.deepEqual(calls, ["http://127.0.0.1:5050/widget/events"]);
  }

  let calls = 0;
  const { runtime } = loadWidget({ colorRewardId: "reward-color" }, async () => {
    calls += 1;
    throw new Error("network unavailable");
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await runtime.forward(redemption("network-error")))), {
    ok: false,
    status: 0,
    outcome: "server_unavailable",
    terminal: true
  });
  assert.equal(calls, 1);
});
