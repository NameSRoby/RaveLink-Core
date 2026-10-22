/** Quick actions delegate to existing owners. Loading this view never changes output or reward state. */
import { openFeaturePage, selectMainTab } from "./feature-navigation.js";
import { initDashboardLayout } from "./dashboard-layout.js";
const panel = document.querySelector('[data-panel="dashboard"]');
const layout = initDashboardLayout(panel);
const $ = (id) => document.getElementById("dashboard" + id);
let state,
  rewards,
  timer,
  reading = false,
  visible = false,
  closed = false;
const busy = new Set();
const noticeRevision = new Map();
const live = () =>
  state && !["idle", "closed", "inactive", "failed", "stopped"].includes(state.music.state);
const errorText = (error) =>
  ({
    song_intake_paused_or_unavailable: "Song rewards remain paused. Resume song intake first.",
    dashboard_rewards_busy:
      "A reward update is still running. Wait for its result before trying again.",
    fullscreen_app_unavailable:
      "No fullscreen app was found. Check your music source or fallbacks.",
    music_restart_required: "Restart Core to load the updated dashboard controls.",
    lighting_restore_failed:
      "Lighting stopped with an output or restoration failure. Open Music controls to check its status.",
  })[error] ||
  "The action could not complete. Check the package or connection and refresh its status.";
function note(id, text, failed = false) {
  if ($(id).textContent !== text) $(id).textContent = text;
  $(id).dataset.error = String(failed);
}
async function request(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || result.ok === false || result.value?.ok === false)
    throw Error(result.error?.code || result.error || result.value?.error || "action_failed");
  return result;
}
const featureCall = (capability, method, payload) =>
  request("/api/features/song-request/call", "POST", { capability, method, payload });
function openTab(id) {
  const button = document.querySelector(`[data-tab="${id}"]`);
  if (!button || button.hidden) {
    note("Notice", "This workspace is unavailable. Enable its package in Packages.", true);
    return;
  }
  selectMainTab(id);
  document.getElementById("moreNav").open = false;
}
function lightTab(id, view) {
  openTab("lights");
  document.querySelector(`[data-light-tab="${id}"]`).click();
  if (view) document.querySelector(`.musicNavigation [data-music-view-target="${view}"]`).click();
}
function featurePage(id, page) {
  const tab = document.querySelector(`[data-tab="feature:${id}"]`);
  if (!tab) {
    openTab("features");
    return;
  }
  openFeaturePage(id, page);
  document.getElementById("moreNav").open = false;
}
panel
  .querySelectorAll("[data-dashboard-tab]")
  .forEach((b) => (b.onclick = () => openTab(b.dataset.dashboardTab)));
panel
  .querySelectorAll("[data-dashboard-light]")
  .forEach(
    (b) => (b.onclick = () => lightTab(b.dataset.dashboardLight, b.dataset.dashboardMusicView)),
  );
panel
  .querySelectorAll("[data-dashboard-feature]")
  .forEach(
    (b) => (b.onclick = () => featurePage(b.dataset.dashboardFeature, b.dataset.dashboardPage)),
  );
function badge(id, text, paused = false) {
  $(id).textContent = text;
  $(id).className = "badge" + (paused ? " warn" : "");
}
function controls() {
  panel.querySelectorAll("[data-dashboard-group]").forEach((button) => {
    button.disabled =
      !state || busy.has(button.dataset.dashboardGroup) || button.dataset.manageable === "false";
  });
  const manageable = rewards?.available && rewards.rewards.some((r) => r.manageable);
  $("PauseRewards").disabled ||=
    !manageable || rewards.rewards.filter((r) => r.manageable).every((r) => r.paused);
  $("ResumeRewards").disabled ||=
    !manageable || rewards.rewards.filter((r) => r.manageable).every((r) => !r.paused);
  $("Intake").disabled ||= !state?.song;
  $("Skip").disabled ||= !state?.song?.canSkip;
  $("MusicStart").disabled ||= !state?.music.ready || live();
  $("Rave").disabled ||= !state?.music.ready;
  $("AutoRave").disabled = !state || busy.has("music");
  panel.querySelectorAll("[data-dashboard-feature]").forEach((button) => {
    button.disabled = !state?.packages.some(
      (p) => p.id === button.dataset.dashboardFeature && p.lifecycle === "active",
    );
  });
  panel
    .querySelectorAll('[data-dashboard-tab="features"]')
    .forEach((button) => (button.disabled = !state?.featuresAvailable));
}
function makeButton(text, group, fn) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  if (group) button.dataset.dashboardGroup = group;
  button.onclick = fn;
  return button;
}
async function action(group, notice, fn, message) {
  if (busy.has(group)) return;
  const revision = (noticeRevision.get(notice) || 0) + 1;
  noticeRevision.set(notice, revision);
  if (notice === "RewardsNotice") delete $(notice).dataset.origin;
  busy.add(group);
  controls();
  note(notice, "Applying…");
  try {
    const detail = await fn();
    if (noticeRevision.get(notice) === revision) note(notice, detail || message);
  } catch (error) {
    if (noticeRevision.get(notice) === revision) note(notice, errorText(error.message), true);
  } finally {
    busy.delete(group);
    await refresh();
    controls();
  }
}
function renderRewards() {
  const rows = rewards?.rewards || [],
    paused = rows.filter((r) => r.paused).length;
  badge(
    "RewardState",
    rewards?.available
      ? rows.length
        ? `${paused} / ${rows.length} PAUSED`
        : "NO MANAGED REWARDS"
      : "UNAVAILABLE",
    paused > 0,
  );
  $("Rewards").replaceChildren(
    ...rows.map((row) => {
      const card = document.createElement("div"),
        copy = document.createElement("div"),
        title = document.createElement("strong"),
        status = document.createElement("small");
      card.className = "dashboardReward";
      title.textContent = row.title;
      status.textContent = `${row.cost.toLocaleString()} points · ${row.paused ? "Paused" : row.enabled ? "Available" : "Disabled in Twitch"}${row.manageable ? "" : " · Cannot manage"}`;
      copy.append(title, status);
      const button = makeButton(row.paused ? "Resume" : "Pause", "rewards", () =>
        updateRewards(row.purpose, !row.paused),
      );
      button.disabled = !row.manageable;
      button.dataset.manageable = String(row.manageable);
      button.setAttribute("aria-label", `${row.paused ? "Resume" : "Pause"} ${row.title}`);
      card.append(copy, button);
      return card;
    }),
  );
  if (!rewards?.available) {
    note(
      "RewardsNotice",
      state?.twitchActive
        ? "Connect Twitch and allow reward management in Twitch settings."
        : "Enable Twitch Integration to manage Channel Points.",
    );
    $("RewardsNotice").dataset.origin = "snapshot";
  } else if (!rows.length) {
    note(
      "RewardsNotice",
      "Create a managed reward in Twitch settings. Rewards created outside Core are left alone.",
    );
    $("RewardsNotice").dataset.origin = "snapshot";
  } else if ($("RewardsNotice").dataset.origin === "snapshot") {
    note("RewardsNotice", "Song rewards stay paused while request intake is paused.");
    delete $("RewardsNotice").dataset.origin;
  }
}
async function updateRewards(purpose, paused) {
  await action("rewards", "RewardsNotice", async () => {
    const result = await request("/api/dashboard/rewards", "POST", { purpose, paused });
    rewards = result.state;
    renderRewards();
    if (result.partial) {
      const held = result.results.some((r) => r.held),
        failed = result.results.some((r) => !r.ok && !r.held);
      return `${held ? "Song rewards remain paused until song intake resumes. " : ""}${failed ? "Some rewards could not update. Check their current state and retry." : "Other selected rewards updated."}`;
    }
    return paused ? "Selected managed rewards paused." : "Selected managed rewards resumed.";
  });
}
function render() {
  const active = state.packages.filter((p) => p.lifecycle === "active").length;
  $("Overview").textContent = `${active} ACTIVE / ${state.packages.length} INSTALLED`;
  const song = state.song;
  badge(
    "IntakeState",
    song ? (song.paused ? "INTAKE PAUSED" : "INTAKE OPEN") : "UNAVAILABLE",
    song?.paused,
  );
  $("NowPlaying").textContent = song?.title || "No song information";
  $("QueueCount").textContent = song
    ? `${song.queued} queued requests`
    : "Enable Song Request to control its queue here.";
  $("Intake").textContent = song?.paused ? "Resume requests" : "Pause requests";
  badge(
    "MusicState",
    live() ? state.music.state.toUpperCase().replaceAll("_", " ") : "STOPPED",
    false,
  );
  $("MusicSource").textContent = state.music.source || "Choose your music source";
  $("MusicSummary").textContent =
    `${state.music.lights || 0} music lights · ${state.music.ready ? "Ready to play" : "Setup or permissions needed"}`;
  $("AutoRave").checked = state.music.autoRave;
  $("ReviewSongs").textContent = state.music.pending
    ? `Review ${state.music.pending} submissions →`
    : "Song library →";
  $("Profiles").replaceChildren(
    ...state.profiles
      .slice(0, 8)
      .map((profile) =>
        makeButton(profile.name, "profiles", () =>
          action(
            "profiles",
            "ProfilesNotice",
            () =>
              request(
                `/lighting-profiles/${encodeURIComponent(profile.id)}/apply`,
                "POST",
                {},
              ).then(() => ""),
            `Applied ${profile.name}.`,
          ),
        ),
      ),
  );
  if (!state.profiles.length)
    $("Profiles").textContent = "Save a light profile to add one-click room setups here.";
  $("Packages").replaceChildren(
    ...state.packages.map((p) => {
      const row = document.createElement("div"),
        copy = document.createElement("div"),
        name = document.createElement("strong"),
        status = document.createElement("small");
      row.className = "dashboardPackage";
      name.textContent = p.name;
      status.textContent = p.lifecycle.replaceAll("-", " ");
      copy.append(name, status);
      const button = makeButton(
        p.lifecycle === "active" && p.pages.length ? "Open" : "Manage",
        null,
        () =>
          p.lifecycle === "active" && p.pages.length
            ? featurePage(p.id, p.pages[0].id)
            : openTab("features"),
      );
      row.append(copy, button);
      return row;
    }),
  );
  if (!state.packages.length)
    $("Packages").textContent =
      "Install optional packages to bring their quick controls into this dashboard.";
  renderRewards();
  controls();
  layout.apply();
  $("Rewards")
    .querySelectorAll('[data-manageable="false"]')
    .forEach((b) => (b.disabled = true));
}
async function refresh() {
  clearTimeout(timer);
  if (closed || !visible || document.hidden || reading || busy.size) return;
  reading = true;
  try {
    const next = await request("/api/dashboard");
    if (next.twitchActive) {
      try {
        rewards = await request("/api/dashboard/rewards");
      } catch {
        rewards = null;
      }
    } else rewards = null;
    state = next;
    render();
    note("Notice", "Overview is up to date.");
  } catch {
    state = null;
    controls();
    badge("Overview", "STATUS UNAVAILABLE", true);
    note(
      "Notice",
      "Dashboard status could not load. If Core was just updated, restart it from the tray and refresh. Controls will retry automatically.",
      true,
    );
  } finally {
    reading = false;
    if (!closed && visible && !document.hidden) timer = setTimeout(refresh, 5000);
  }
}
$("PauseRewards").onclick = () => updateRewards("all", true);
$("ResumeRewards").onclick = () => updateRewards("all", false);
$("Intake").onclick = () =>
  action(
    "song",
    "SongNotice",
    () =>
      featureCall("song.queue.admin.v1", "moderate", {
        action: state.song.paused ? "resume" : "pause",
      }).then(() => ""),
    "Request intake updated.",
  );
$("Skip").onclick = () =>
  action(
    "song",
    "SongNotice",
    () =>
      featureCall("song.queue.admin.v1", "moderate", {
        action: "skip",
        entryId: state.song.entryId,
      }).then(() => ""),
    "Current request skipped.",
  );
const musicCall = (method, payload) =>
  request("/api/music-to-light/call", "POST", { capability: "music.session.v1", method, payload });
$("MusicStart").onclick = () =>
  action(
    "music",
    "MusicNotice",
    () => musicCall("start", { mode: "live" }).then(() => ""),
    "Lighting start requested. Check its live state above.",
  );
$("Rave").onclick = () =>
  action(
    "music",
    "MusicNotice",
    () => request("/api/music-to-light/rave/start", "POST", {}).then(() => ""),
    "Rave started.",
  );
// Stop remains available during setup, a long Start, or a stale status read.
$("MusicStop").onclick = () =>
  action(
    "stop",
    "MusicNotice",
    () =>
      musicCall("stop", null).then((result) => {
        if (
          result.value?.session?.state === "failed" ||
          result.value?.session?.failedOperations > 0
        )
          throw Error("lighting_restore_failed");
        return "";
      }),
    "Lighting stopped; prior state restored where still owned.",
  );
$("AutoRave").onchange = () =>
  action(
    "music",
    "MusicNotice",
    () =>
      request("/api/music-to-light/songs/policy", "POST", { enabled: $("AutoRave").checked }).then(
        () => "",
      ),
    "Auto-Rave preference saved.",
  );
$("Refresh").onclick = refresh;
const observer = new IntersectionObserver((entries) => {
  visible = entries.some((e) => e.isIntersecting);
  clearTimeout(timer);
  if (visible) void refresh();
});
observer.observe(panel);
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (!document.hidden) void refresh();
});
addEventListener("pagehide", () => {
  closed = true;
  clearTimeout(timer);
  observer.disconnect();
});
addEventListener("pageshow", () => {
  if (closed) {
    closed = false;
    observer.observe(panel);
  }
});
