/** Read compatibility only. Retired response names never enter active designs. */
const retiredBehaviors = Object.freeze([
  "ambientContrast",
  "ambientAttackMs",
  "ambientReleaseMs",
  "ambientBed",
  "bandsBed",
  "bandSeparation",
  "bandSensitivity",
]);
module.exports = {
  preset: (value) => (["ambient", "bands"].includes(value) ? "pulse" : value),
  effect: (value) => (["wash", "bands"].includes(value) ? "pulse" : value),
  palette: (value) => (value === "prism-bands" ? "prism-pulse" : value),
  retiredBehaviors,
};
