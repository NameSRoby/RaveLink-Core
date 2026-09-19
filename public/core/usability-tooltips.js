(() => {
const buttonExplanations = {
  discoverHue: "Search the local network for Philips Hue bridges. After discovery, the next pairing step will be shown.",
  pairHueManual: "Connect to the selected Hue bridge after pressing its physical link button.",
  discoverWiz: "Search the local network for WiZ lights and choose which fixtures to add.",
  discoverGovee: "Search for Govee lights with LAN Control enabled. This adapter is an alpha feature.",
  refreshFixtures: "Reload saved fixtures and their current connection state.",
  saveFixture: "Save the fixture information currently entered in this form.",
  clearFixture: "Clear the fixture form without deleting saved fixtures.",
  applyColor: "Send the entered color and brightness to the selected lights.",
  runControlRoutingTest: "Run this command through the saved Twitch lighting route and control the fixtures it resolves to.",
  stopControlRoutingTest: "Stop effects running on fixtures in the default saved Twitch route.",
  generateWidget: "Generate the StreamElements widget using the selected rewards and secure intake token.",
  testIntakeToken: "Verify the entered widget token with a harmless request that cannot change lights.",
  copyWidget: "Copy the generated widget code to the clipboard.",
  themeButton: "Open HUD color and Developer Mode settings.",
  resetTheme: "Restore the default RaveLink HUD colors."
};
const tooltip = document.createElement("div");
tooltip.className = "hudTooltip";
tooltip.hidden = true;
tooltip.setAttribute("role", "tooltip");
document.body.append(tooltip);
let tooltipTimer = 0;
let tooltipButton = null;
function buttonExplanation(button) {
  const explicit = button.dataset.tooltip || button.getAttribute("title") || buttonExplanations[button.id];
  if (explicit) {
    button.dataset.tooltip = explicit;
    button.removeAttribute("title");
    return explicit;
  }
  const text = button.textContent.trim().replace(/\s+/g, " ");
  if (button.matches("[data-tab]")) return `Open the ${text.toLowerCase()} workspace.`;
  if (button.matches("[data-theme]")) return `Apply the ${text.toLowerCase()} HUD color theme.`;
  return text ? `Run the ${text.toLowerCase()} action.` : "Activate this control.";
}
function hideButtonTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = 0;
  tooltipButton = null;
  tooltip.hidden = true;
}
document.addEventListener("pointerover", event => {
  const button = event.target.closest?.("button");
  if (!button || button === tooltipButton) return;
  hideButtonTooltip();
  tooltipButton = button;
  const explanation = buttonExplanation(button);
  tooltipTimer = setTimeout(() => {
    if (tooltipButton !== button) return;
    tooltip.textContent = explanation;
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left));
    const below = rect.bottom + 8;
    const top = below + tooltip.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - tooltip.offsetHeight - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, 1200);
}, true);
document.addEventListener("pointerout", event => {
  if (!tooltipButton || event.relatedTarget && tooltipButton.contains(event.relatedTarget)) return;
  if (event.target === tooltipButton || tooltipButton.contains(event.target)) hideButtonTooltip();
}, true);
window.addEventListener("blur", hideButtonTooltip);
})();
