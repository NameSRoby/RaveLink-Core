/** Integration setup stays with Core; LAN browsers never receive provider tokens. */
export function createDeckIntegrations({ request, refresh, onTwitchSetup }) {
  const dialog = document.createElement("dialog");
  dialog.className = "deckEditor deckIntegrations";
  dialog.id = "deckIntegrations";
  document.body.append(dialog);
  dialog.setAttribute("aria-labelledby", "deckIntegrationTitle");
  dialog.innerHTML =
    '\n<div class="deckEditorHeading"><h2 id="deckIntegrationTitle">Connections</h2><button id="deckIntegrationsClose" type="button" aria-label="Close connections">Close</button></div>\n<nav class="deckSettingsTabs" aria-label="Connections"><button id="deckKeyboardTab" type="button" aria-pressed="true">Keyboard keys</button><button id="deckTwitchTab" type="button" aria-pressed="false">Twitch</button></nav>\n<p id="deckIntegrationNotice" class="deckEditorNotice" role="status" aria-live="polite"></p>\n<div class="deckIntegrationPanels">\n<div id="deckKeyboardPanel">\n<section><h3>Keyboard buttons</h3><p>Add a Keyboard shortcut action to any button. Choose F13–F24 or enter a key combination. Input is sent on the RaveLink PC, including when pressed from a LAN browser.</p><p>No Discord connection or mod is required.</p></section>\n</div>\n<div id="deckTwitchPanel" hidden>\n<section><h3>Twitch connection</h3><p id="deckClipStatus" class="deckConnectionStatus" role="status"></p><p>Choose permissions in Twitch Connection. You can grant clipping, chat or rewards access separately and see which features are ready.</p><button id="deckClipAuthorize" type="button">Choose Twitch permissions</button></section>\n<section><h3>Chat clipping</h3><label class="deckCheck"><input id="deckClipChat" type="checkbox"><span>Allow viewers to use !clip</span></label><label class="deckField"><span>Who can request a clip?</span><select id="deckClipChatAccess"><option value="everyone">Everyone</option><option value="moderators">Broadcaster and moderators</option></select></label><p class="deckEditorHint">Viewers can add a title: <code>!clip 3k on tracer</code>. Requires clip and chat access. Your broadcast must be live and allow clips.</p></section>\n</div>\n</div>';
  const $ = (id) => document.getElementById("deck" + id);
  $("TwitchPanel").insertAdjacentHTML(
    "beforeend",
    `
    <section class="deckClipModeration" aria-labelledby="deckClipModerationTitle">
      <h3 id="deckClipModerationTitle">Clip title moderation</h3>
      <p>Applies to button titles and <code>!clip</code>. Matching words become <strong>****</strong> by default.</p>
      <label class="deckCheck"><input id="deckClipFilter" type="checkbox"><span>Filter clip titles</span></label>
      <div class="deckClipPolicy">
        <label class="deckField"><span>When a word matches</span><select id="deckClipFilterMode"><option value="mask">Replace with ****</option><option value="reject">Reject the clip request</option></select></label>
        <label class="deckCheck"><input id="deckClipDefaultWords" type="checkbox"><span>Use the English profanity filter</span></label>
        <details><summary>Custom words &amp; exceptions</summary>
          <div class="deckClipWordLists">
            <label class="deckField"><span>Blocked words or phrases</span><textarea id="deckClipBlocked" rows="4" maxlength="8319" placeholder="One word or phrase per line"></textarea></label>
            <label class="deckField"><span>Allowed exceptions</span><textarea id="deckClipAllowed" rows="4" maxlength="8319" placeholder="One word or phrase per line"></textarea></label>
          </div>
          <p class="deckEditorHint">Up to 128 entries per list, 64 characters each. Custom entries match whole words or phrases, ignoring case. Exceptions override matching words inside that phrase. The English filter also checks common disguised spellings; add your own terms for other languages.</p>
        </details>
        <div class="deckClipTest">
          <label class="deckField"><span>Try a title</span><input id="deckClipPreviewTitle" type="text" maxlength="100" placeholder="Preview without making a clip"></label>
          <button id="deckClipPreview" type="button">Test filter</button>
        </div>
        <output id="deckClipPreviewResult" class="deckClipPreviewResult" aria-live="polite"></output>
      </div>
      <div class="deckEditorActions"><button id="deckClipSaveFilter" type="button">Save title filter</button></div>
    </section>`,
  );
  function chooseTab(twitch) {
    $("KeyboardPanel").hidden = twitch;
    $("TwitchPanel").hidden = !twitch;
    $("KeyboardTab").setAttribute("aria-pressed", String(!twitch));
    $("TwitchTab").setAttribute("aria-pressed", String(twitch));
  }
  $("KeyboardTab").onclick = () => chooseTab(false);
  $("TwitchTab").onclick = () => chooseTab(true);
  let busy = false,
    snapshot = null;
  function controls() {
    dialog.querySelectorAll("button,input,select,textarea").forEach((el) => (el.disabled = busy));
    const clips = snapshot?.twitchClips || {};
    $("ClipChat").disabled = busy || clips.code === "twitch_integration_unavailable";
    $("ClipChatAccess").disabled = busy || !$("ClipChat").checked;
    dialog
      .querySelectorAll(
        ".deckClipPolicy input,.deckClipPolicy select,.deckClipPolicy textarea,.deckClipPolicy button",
      )
      .forEach((el) => (el.disabled = busy || !$("ClipFilter").checked));
  }
  function message(value, error = false) {
    $("IntegrationNotice").textContent = value;
    $("IntegrationNotice").dataset.error = String(error);
  }
  async function read() {
    const state = await request("/api/control-deck/integrations");
    snapshot = state;
    const clips = state.twitchClips || {};
    $("ClipStatus").textContent = clips.scopeGranted
      ? clips.chatAvailable
        ? clips.chatReplyAvailable === false
          ? "Clips and !clip are ready. Chat replies need Send chat permission."
          : "Clip access ready; chat connection ready."
        : "Clip access ready. Chat needs the Twitch chat connection."
      : clips.connected
        ? "Twitch is connected; grant clip access."
        : "Connect Twitch for clip access.";
    $("ClipChat").checked = clips.config?.chatEnabled === true;
    $("ClipChatAccess").value = clips.config?.chatAccess || "everyone";
    const policy = clips.config?.titleModeration || {};
    $("ClipFilter").checked = policy.enabled !== false;
    $("ClipFilterMode").value = policy.mode || "mask";
    $("ClipDefaultWords").checked = policy.useDefaultList !== false;
    $("ClipBlocked").value = (policy.blockedWords || []).join("\n");
    $("ClipAllowed").value = (policy.allowedWords || []).join("\n");
    controls();
  }
  async function run(fn, reload = true) {
    if (busy) return;
    busy = true;
    controls();
    try {
      await fn();
      if (reload) {
        await read();
        await refresh();
      }
    } catch (error) {
      message(String(error.message).replaceAll("_", " "), true);
    } finally {
      busy = false;
      controls();
    }
  }
  $("IntegrationsClose").onclick = () => dialog.close();
  $("ClipAuthorize").onclick = () => {
    if (onTwitchSetup?.() === true) dialog.close();
    else
      message(
        "Install or enable Twitch Integration under Packages, then open its Connection page.",
        true,
      );
  };
  const configure = () =>
    void run(async () => {
      await request("/api/control-deck/integrations/twitch-clips/configure", "POST", {
        chatEnabled: $("ClipChat").checked,
        chatAccess: $("ClipChatAccess").value,
      });
      message("Clip chat preferences saved.");
    });
  $("ClipChat").onchange = configure;
  $("ClipChatAccess").onchange = configure;
  const words = (id) =>
    $(id)
      .value.split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
  const policy = () => ({
    enabled: $("ClipFilter").checked,
    mode: $("ClipFilterMode").value,
    useDefaultList: $("ClipDefaultWords").checked,
    blockedWords: words("ClipBlocked"),
    allowedWords: words("ClipAllowed"),
  });
  $("ClipFilter").onchange = controls;
  $("ClipSaveFilter").onclick = () => {
    const titleModeration = policy();
    void run(async () => {
      await request("/api/control-deck/integrations/twitch-clips/configure", "POST", {
        titleModeration,
      });
      message("Clip title filter saved.");
    });
  };
  $("ClipPreview").onclick = () => {
    const draft = { title: $("ClipPreviewTitle").value, titleModeration: policy() };
    void run(async () => {
      const result = await request(
        "/api/control-deck/integrations/twitch-clips/preview",
        "POST",
        draft,
      );
      $("ClipPreviewResult").textContent = result.accepted
        ? `Title: ${result.title || "(use the broadcast title)"}${result.matched ? " · Words replaced" : " · No matching words"}`
        : "This title would be rejected. No clip was created.";
      message("Preview only. Save the filter to apply these choices.");
    }, false);
  };
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  return {
    async open() {
      snapshot = null;
      $("ClipPreviewResult").textContent = "";
      dialog.showModal();
      message("");
      controls();
      try {
        await read();
      } catch (error) {
        message(String(error.message).replaceAll("_", " "), true);
      }
    },
  };
}
