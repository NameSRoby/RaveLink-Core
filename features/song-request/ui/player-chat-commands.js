/** One shared command policy for every music provider. Drafts survive provider
 * and workspace changes; only Save writes to the host. Reload explicitly discards
 * a draft. Skip/remove scope maps to separate command and anyone-song grants so
 * disabling a command cannot accidentally leave moderation enabled.
 */
/* exported installChatCommandPermissions */
function installChatCommandPermissions(container) {
  const section = document.createElement("section");
  section.id = "chatCommandSettings";
  section.innerHTML =
    '<h2>Chat commands & permissions</h2><p>Choose who can use each command on YouTube, SoundCloud, Spotify and TIDAL. The broadcaster always has full access. Twitch must be connected for chat commands to work. Enable chat song-request intake in Twitch Integration to accept !sr; playback controls work with either reward intake.</p><p>Own songs means requests made by that person. Letting viewers or VIPs affect anyone’s songs or ban other requesters is not recommended. Volume always respects your configured output range.</p><fieldset disabled><legend>Command access by role</legend><div style="overflow-x:auto"><table><thead><tr><th>Command</th><th>Moderators</th><th>VIPs</th><th>Viewers</th></tr></thead><tbody></tbody></table></div></fieldset><div class="actions"><button type="button" data-save disabled>Save command permissions</button><button type="button" data-reload>Reload saved permissions</button></div><p role="status" data-status>Loading command permissions…</p>';
  container.append(section);
  const commands = {
    request: "!sr / !songrequest",
    volume: "!volume 0-100",
    skip: "!skip",
    remove: "!remove [song]",
    pause: "!pause playback",
    resume: "!resume playback",
    ban: "!ban requester",
    unban: "!unban requester",
    timeout: "!timeout requester",
    untimeout: "!untimeout requester",
    bansong: "!bansong",
    unbansong: "!unbansong",
  };
  const roles = { moderator: "Moderators", vip: "VIPs", viewer: "Viewers" };
  const fields = [],
    status = section.querySelector("[data-status]"),
    save = section.querySelector("[data-save]"),
    reload = section.querySelector("[data-reload]");
  let dirty = false,
    pending = false,
    loaded = false;
  for (const [command, title] of Object.entries(commands)) {
    const row = document.createElement("tr"),
      label = document.createElement("th");
    label.scope = "row";
    label.textContent = title;
    row.append(label);
    for (const [role, name] of Object.entries(roles)) {
      const cell = document.createElement("td"),
        scoped = ["skip", "remove"].includes(command),
        input = document.createElement(scoped ? "select" : "input");
      input.dataset.command = command;
      input.dataset.role = role;
      input.setAttribute("aria-label", `${title}: ${name}`);
      if (scoped)
        for (const [value, text] of [
          ["disabled", "Disabled"],
          ["own", "Own songs"],
          ["any", "Anyone’s songs"],
        ]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          input.append(option);
        }
      else input.type = "checkbox";
      input.onchange = () => {
        dirty = true;
        status.textContent = "Unsaved command permissions.";
      };
      fields.push(input);
      cell.append(input);
      row.append(cell);
    }
    section.querySelector("tbody").append(row);
  }
  function render(value) {
    const grants = value.commandPermissions || {};
    for (const input of fields) {
      const { command, role } = input.dataset;
      const enabled =
        grants[command]?.[role] ??
        (role === "moderator" || ["request", "skip", "remove"].includes(command));
      if (input.tagName === "SELECT")
        input.value = !enabled
          ? "disabled"
          : (grants[command + "Any"]?.[role] ?? role === "moderator")
            ? "any"
            : "own";
      else input.checked = enabled;
    }
    loaded = true;
    dirty = false;
    section.querySelector("fieldset").disabled = false;
    save.disabled = false;
    status.textContent = value.connected
      ? "Saved permissions loaded."
      : "Saved permissions loaded. Connect Twitch to use chat commands.";
  }
  async function refresh(force = false) {
    if (pending || (dirty && !force)) return;
    pending = true;
    reload.disabled = true;
    save.disabled = true;
    section.querySelector("fieldset").disabled = true;
    try {
      const result = await call("song.chat.commands.v1", "status");
      if (!result.ok) throw new Error(result.error || "Could not load command permissions.");
      render(result);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      pending = false;
      reload.disabled = false;
      save.disabled = !loaded;
      section.querySelector("fieldset").disabled = !loaded;
    }
  }
  save.onclick = async () => {
    if (pending || !loaded) return;
    const commandPermissions = {};
    for (const input of fields) {
      const { command, role } = input.dataset;
      const scoped = input.tagName === "SELECT";
      (commandPermissions[command] ||= {})[role] = scoped
        ? input.value !== "disabled"
        : input.checked;
      if (scoped) (commandPermissions[command + "Any"] ||= {})[role] = input.value === "any";
    }
    pending = true;
    save.disabled = reload.disabled = true;
    // Freeze the submitted draft while saving; a slow reply must not overwrite a
    // newer edit that the operator made while the request was in flight.
    section.querySelector("fieldset").disabled = true;
    try {
      const result = await call("song.chat.commands.v1", "configure", { commandPermissions });
      if (!result.ok) throw new Error(result.error || "Could not save command permissions.");
      render(result);
      status.textContent = "Command permissions saved for every music provider.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      pending = false;
      save.disabled = reload.disabled = false;
      section.querySelector("fieldset").disabled = false;
    }
  };
  reload.onclick = () => void refresh(true);
  return { refresh };
}
