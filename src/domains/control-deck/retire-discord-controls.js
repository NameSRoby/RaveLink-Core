/** Retire removed built-in controls while preserving layout and unrelated macros. */
const retired = new Set(
  ["camera", "leave-voice", "open", "streamer"].map((id) => "mod:ravelink.discord-controls:" + id),
);
module.exports = function retireDiscordControls(config) {
  const next = structuredClone(config);
  for (const page of next.pages) {
    page.buttons = page.buttons.filter((button) => {
      let removed = false;
      for (const key of ["steps", "alternateSteps", "holdSteps"]) {
        if (!Array.isArray(button[key])) continue;
        button[key] = button[key].map((step) => {
          const shortcut = {
            "mod:ravelink.discord-controls:microphone": "F13",
            "mod:ravelink.discord-controls:deafen": "F14",
          }[step.actionId];
          return shortcut ? { ...step, actionId: "native.hotkey", params: { shortcut } } : step;
        });
        button[key] = button[key].filter((step) => {
          if (!retired.has(step.actionId)) return true;
          removed = true;
          return false;
        });
      }
      return !removed || button.steps?.length > 0;
    });
  }
  return next;
};
