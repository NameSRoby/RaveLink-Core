/** Private media selection; uploads do not execute a button. */
export function createScreenEditor({ request, onChange }) {
  const element = document.createElement("section");
  element.className = "deckScreenEditor";
  element.innerHTML =
    '<h3>Button screen background</h3><p class="deckFieldHelp">One picture, GIF or muted video across the buttons. Gaps stay clear.</p><label class="deckField"><span>Choose media</span><input type="file" accept="image/png,image/jpeg,image/gif,video/mp4,video/webm"></label><div class="deckScreenEditorOptions"><label class="deckField"><span>Fit</span><select aria-label="Screen media fit"><option value="cover">Fill the button area</option><option value="contain">Fit whole image</option></select></label><label class="deckField"><span>Brightness</span><input type="range" min="10" max="100" value="70" aria-label="Screen media brightness"></label><button type="button">Remove background</button></div><p role="status" class="deckEditorNotice"></p>';
  const file = element.querySelector('[type="file"]'),
    fit = element.querySelector("select"),
    brightness = element.querySelector('[type="range"]'),
    notice = element.querySelector('[role="status"]');
  let mediaId = "";
  file.onchange = async () => {
    const asset = file.files[0];
    if (!asset) return;
    const video = asset.type.startsWith("video/");
    if (
      !["image/png", "image/jpeg", "image/gif", "video/mp4", "video/webm"].includes(asset.type) ||
      asset.size > (video ? 16777216 : 8388608)
    ) {
      notice.textContent = "Choose an image/GIF up to 8 MB or MP4/WebM up to 16 MB.";
      return;
    }
    file.disabled = true;
    notice.textContent = "Adding background…";
    try {
      const result = await request("/api/control-deck/screen-media", "POST", asset, true);
      mediaId = result.id;
      notice.textContent = "Background ready. Save layout to keep it.";
      onChange();
    } catch (error) {
      notice.textContent = String(error.message).replaceAll("_", " ");
    } finally {
      file.disabled = false;
    }
  };
  fit.onchange = brightness.oninput = onChange;
  element.querySelector("button").onclick = () => {
    mediaId = "";
    file.value = "";
    notice.textContent = "";
    onChange();
  };
  return {
    element,
    read: () => ({ mediaId, fit: fit.value, brightness: Number(brightness.value) }),
    fill(value) {
      mediaId = value?.mediaId || "";
      fit.value = value?.fit || "cover";
      brightness.value = value?.brightness ?? 70;
      notice.textContent = mediaId ? "A private background is selected." : "";
    },
  };
}
