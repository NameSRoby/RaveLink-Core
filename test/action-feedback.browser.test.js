const test = require("node:test"),
  assert = require("node:assert/strict");
const { chromium } = require("playwright");
const install = require("../public/core/action-feedback");
test("action feedback follows actual asynchronous results and ignores background polling", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button id="action">Save change</button><iframe></iframe>');
  await page.evaluate(() => {
    window.call = () =>
      new Promise((resolve) => {
        window.release = resolve;
      });
    document.querySelector("button").onclick = async () => {
      await window.call("fixture", "mutate");
    };
  });
  await page.evaluate(install);
  await page.click("#action");
  assert.equal(await page.locator("#action").getAttribute("aria-busy"), "true");
  await page.locator("#actionFeedback:not([hidden])").waitFor();
  assert.match(await page.locator("#actionFeedback").innerText(), /working/);
  await page.evaluate(() => window.release({ ok: true }));
  await page.locator("#action[data-action-state=success]").waitFor();
  assert.equal(
    await page.locator("#actionFeedback").isHidden(),
    true,
    "routine success does not leave a popup",
  );
  await page.waitForFunction(() => !document.querySelector("#action").dataset.actionState);
  await page.click("#action");
  await page.evaluate(() => window.release({ ok: false }));
  await page.locator("#action[data-action-state=error]").waitFor();
  assert.match(await page.locator("#actionFeedback").innerText(), /could not complete/);
  const message = await page.locator("#actionFeedback").innerText();
  await page.evaluate(() => {
    window.call("fixture", "status");
    window.release({ ok: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        source: document.querySelector("iframe").contentWindow,
        data: {
          channel: "ravelink-feature-ui-v1",
          type: "action-feedback",
          state: "success",
          message: "forged",
        },
      }),
    );
  });
  assert.equal(await page.locator("#actionFeedback").innerText(), message);
});

test("multi-stage actions stay busy until the handler completes and report a later failure", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button id="action">Import tracks</button>');
  await page.evaluate(() => {
    window.calls = [];
    window.call = () => new Promise((resolve) => window.calls.push(resolve));
    window.gate = new Promise((resolve) => (window.continueImport = resolve));
    document.querySelector("button").onclick = async () => {
      await window.call("fixture", "mutate");
      await window.gate;
      await window.call("fixture", "mutate");
    };
  });
  await page.evaluate(install);
  await page.click("#action");
  await page.evaluate(() => window.calls.shift()({ ok: true }));
  await page.waitForTimeout(30);
  assert.equal(await page.locator("#action").getAttribute("aria-busy"), "true");
  await page.evaluate(() => window.continueImport());
  await page.waitForFunction(() => window.calls.length === 1);
  await page.evaluate(() => window.calls.shift()({ ok: false }));
  await page.locator("#action[data-action-state=error]").waitFor();
});

test("quick actions and provider choices avoid popup flashes or lingering selection decorations", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<button id="quick">Save</button><div data-choice-for="provider"><button id="provider" data-choice-value="spotify">Spotify</button></div>',
  );
  await page.evaluate(() => {
    window.call = async () => ({ ok: true });
    for (const button of document.querySelectorAll("button"))
      button.onclick = () => window.call("fixture", "select");
  });
  await page.evaluate(install);
  await page.click("#quick");
  assert.equal(await page.locator("#actionFeedback").isHidden(), true);
  await page.click("#provider");
  assert.equal(await page.locator("#provider").getAttribute("data-action-state"), null);
  await page.waitForFunction(() => !document.querySelector("#quick").dataset.actionState);
  assert.equal(await page.locator("#actionFeedback").isHidden(), true);
});
