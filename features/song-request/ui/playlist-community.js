/**
 * Playlist community.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#playlist-transfers-and-uncertain-writes
 */
window.installCommunityPlaylists = function (libraryView) {
  const section = document.createElement("section");
  section.id = "communityPlaylists";
  section.hidden = true;
  section.className = "playlistTools";
  const heading = document.createElement("h3");
  heading.textContent = "Community playlists";
  const help = document.createElement("p");
  help.textContent =
    "The Add to playlist Channel Points reward queues each accepted song and saves it here. Spotify and TIDAL also sync to your connected account.";
  const rows = document.createElement("div");
  section.append(heading, help, rows);
  libraryView.querySelector(".libraryDetails").prepend(section);
  const original = render;
  render = function (library, queue) {
    original(library, queue);
    const lists = library.community || [];
    section.hidden = !lists.length;
    rows.replaceChildren();
    for (const list of lists) {
      const row = document.createElement("div");
      row.className = "band";
      row.append(window.PlaylistProviderUI.badge(list.provider));
      const label = document.createElement("span");
      label.setAttribute("role", "status");
      label.textContent =
        {
          local: "Saved in RaveLink",
          synced: "Account playlist synced",
          pending: "Saved locally - account sync pending",
          review: "Saved locally - check account playlist before retrying",
        }[list.phase] || "Saved locally";
      row.append(label);
      const open = document.createElement("button");
      open.textContent = "View songs";
      open.onclick = async () => {
        await mutate(
          { action: "select", collectionId: list.collectionId },
          "Community playlist selected.",
        );
      };
      row.append(open);
      if (list.accountUrl) {
        const link = document.createElement("a");
        link.textContent = "Open account playlist";
        link.href = list.accountUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        row.append(link);
      }
      if (list.error) {
        const note = document.createElement("p");
        note.textContent =
          list.phase === "review"
            ? "A write was not confirmed. Check the account playlist first to avoid duplicate songs."
            : list.provider === "spotify"
              ? "Open Spotify with the updated RaveLink companion to sync."
              : "Connect TIDAL playlist access in Transfers, then retry.";
        row.append(note);
        const retry = document.createElement("button");
        retry.textContent = "Check sync";
        retry.onclick = () =>
          mutate(
            { action: "community_retry", provider: list.provider },
            "Checking account playlist.",
          );
        row.append(retry);
        if (list.phase === "review") {
          const missing = document.createElement("button");
          missing.textContent = "Confirmed missing - retry";
          missing.title =
            "Only use after checking that the unconfirmed playlist or songs are missing from your account.";
          missing.onclick = () =>
            mutate(
              {
                action: "community_retry",
                provider: list.provider,
                confirmAbsent: true,
              },
              "Retrying after your confirmation.",
            );
          row.append(missing);
        }
      }
      rows.append(row);
    }
  };
  // The first Library response can arrive before this addon is installed.
  // Queue a refresh so its saved playlists also render on that first visit.
  void refresh();
};
