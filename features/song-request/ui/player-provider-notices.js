/**
 * Player provider notices.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
/* exported installProviderNotices */
function installProviderNotices() {
  const details = document.createElement("details");
  details.id = "providerKnownIssues";
  details.className = "providerKnownIssues";
  details.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "Known issues & report a bug";
  const text = document.createElement("p");
  const report = document.createElement("a");
  report.textContent = "Report a bug on GitHub";
  report.href = "https://github.com/NameSRoby/RaveLink-Core/issues/new?template=bug_report.yml";
  report.target = "_blank";
  report.rel = "noopener noreferrer";
  const privacy = document.createElement("p");
  privacy.textContent =
    "Include your RaveLink version and steps to reproduce. Remove tokens, credentials and private account details before sharing logs or screenshots.";
  details.append(summary, text, report, privacy);
  document.querySelector(".playerSide").prepend(details);
  const style = document.createElement("style");
  style.textContent =
    "#providerKnownIssues{grid-column:1/-1;border:1px solid var(--edge);border-radius:7px;padding:10px 12px;font-size:12px;margin:4px 0 12px}#providerKnownIssues summary{cursor:pointer;color:var(--muted)}#providerKnownIssues p{color:var(--muted);line-height:1.6;margin:10px 0}#providerKnownIssues a{color:var(--text)}";
  document.head.append(style);
  const notes = {
    spotify:
      "Spotify updates can require preparing and reopening the companion. Free-account ads and playback restrictions still apply. Unconfirmed queue or community-playlist writes need review before retrying. The official Premium API cannot remove individual queued songs; the companion can remove entries it delivered. Live Premium and community-playlist testing remains limited.",
    soundcloud:
      "Public search can be affected by SoundCloud site changes or rate limits. Some tracks are private, unavailable, limited to previews or blocked from embedded playback. Keep the RaveLink player open for playback. Availability and ads are controlled by SoundCloud. Direct account-library writes are not supported.",
  };
  let provider = "";
  return {
    update(view) {
      const selected = $("songPlayerProvider").value;
      details.hidden = view !== "player" || !notes[selected];
      if (selected !== provider) {
        provider = selected;
        details.open = false;
        text.textContent = notes[selected] || "";
      }
    },
  };
}
