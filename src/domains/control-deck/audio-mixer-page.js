/** Installation-independent mixer page. Windows targets are discovered live in the UI. */
function audioPage(pages = []) {
  let id = "audio-mixer",
    suffix = 1;
  while (pages.some((page) => page.id === id)) id = "audio-mixer-" + suffix++;
  const buttonIds = new Set(pages.flatMap((page) => page.buttons.map((button) => button.id)));
  let buttonId = "mixer-song-volume";
  while (buttonIds.has(buttonId)) buttonId = "mixer-song-volume-" + suffix++;
  return {
    id,
    name: "Audio mixer",
    mixer: { enabled: true, hiddenTargets: [] },
    buttons: [
      {
        id: buttonId,
        title: "Song Request",
        kind: "slider",
        steps: [{ actionId: "song.volume", params: { level: 100 }, delayMs: 0 }],
        appearance: { symbol: "\u266b", sliderStyle: "mixer", sliderOrientation: "inherit" },
      },
    ],
  };
}
function ensure(pages) {
  if (pages.some((page) => page.mixer?.enabled) || pages.length >= 12) return pages;
  const next = [...pages];
  next.splice(Math.min(1, next.length), 0, audioPage(pages));
  return next;
}
module.exports = { audioPage, ensure };
