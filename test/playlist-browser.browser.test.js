const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
test("playlist multi-selection spans search and pages, survives loaded-list refreshes and can be cleared", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<label>Playlists<select id="playlists"></select></label>');
  await page.addScriptTag({
    content: fs.readFileSync(
      path.join(__dirname, "../features/song-request/ui/playlist-browser.js"),
      "utf8",
    ),
  });
  await page.evaluate(() => {
    const select = document.querySelector("select");
    for (let i = 0; i < 10; i++) select.add(new Option("Playlist " + i, String(i)));
    window.picker = window.installPlaylistBrowser(select, "test playlists", {
      multiple: true,
    });
  });
  const selected = () => page.evaluate(() => window.picker.selected().map((row) => row.id));
  assert.deepEqual(await selected(), []);
  await page.getByRole("searchbox").fill("Playlist 9");
  await page.getByRole("button", { name: "Select all playlists", exact: true }).click();
  assert.equal((await selected()).length, 10);
  await page.getByRole("button", { name: "Playlist 9", exact: true }).click();
  assert.equal((await selected()).length, 9);
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Playlist 9", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await page.evaluate(() => {
    const select = document.querySelector("select");
    select.replaceChildren(
      ...Array.from({ length: 11 }, (_, i) => new Option("Playlist " + i, String(i))),
    );
  });
  await page.waitForFunction(() =>
    document.querySelector(".playlistSelectionTools span").textContent.includes("9 of 11"),
  );
  assert.equal((await selected()).length, 9);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  assert.deepEqual(await selected(), []);
  await page.evaluate(() => {
    document.querySelector("select").disabled = true;
  });
  await page.getByRole("button", { name: "Select all playlists", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Select all playlists", exact: true }).isDisabled(),
    true,
  );
});

test("Library addons render existing playlists even when the first Library response arrived before installation", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<section id="library"><section class="libraryDetails"></section></section>',
  );
  await page.evaluate(() => {
    window.render = () => {};
    window.mutate = async () => {};
    window.PlaylistProviderUI = {
      badge: (provider) => {
        const node = document.createElement("span");
        node.textContent = provider;
        return node;
      },
    };
    const library = {
      community: [{ provider: "spotify", phase: "local", collectionId: "saved" }],
    };
    window.refresh = async () => {
      await Promise.resolve();
      window.render(library, {});
    };
    window.render(library, {});
  });
  await page.addScriptTag({
    content: fs.readFileSync(
      path.join(__dirname, "../features/song-request/ui/playlist-community.js"),
      "utf8",
    ),
  });
  await page.evaluate(() => window.installCommunityPlaylists(document.querySelector("#library")));
  await page.getByRole("button", { name: "View songs", exact: true }).waitFor();
  assert.equal(await page.locator("#communityPlaylists").isVisible(), true);
});
