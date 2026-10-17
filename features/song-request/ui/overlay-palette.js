/**
 * Cover-derived accents, shared by the designer and OBS.
 * Decode a small, separate CORS-enabled probe: changing the display image's CORS
 * mode would make covers disappear on hosts that prohibit canvas access. Failure
 * leaves the caller's provider/theme fallback in place. A generation token keeps
 * a late cover from recoloring the next song. Cache and concurrent probes are
 * bounded; image loading and canvas sampling never run on playback clock ticks.
 */
(function (root) {
  const colors = new Map(),
    pending = new Map(),
    generations = new WeakMap();
  function sample(image) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data,
      buckets = new Map();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 128) continue;
      const rgb = [...pixels.slice(index, index + 3)];
      const high = Math.max(...rgb),
        low = Math.min(...rgb);
      const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      if (luminance < 60 || low > 230) continue;
      const key = rgb.map((v) => Math.floor(v / 32)).join(":");
      const bucket = buckets.get(key) || { rgb, weight: 0 };
      bucket.weight += 1 + (3 * (high - low)) / 255;
      buckets.set(key, bucket);
    }
    const best = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
    if (!best) return null;
    // Accents sit on dark panels; brighten dark extracted colors without changing
    // the text/muted palette, which must remain legible independently of the cover.
    const brightness = best.rgb.reduce(
      (sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index],
      0,
    );
    const lift = Math.max(0, 135 - brightness);
    return (
      "#" +
      best.rgb
        .map((v) =>
          Math.min(255, Math.round(v + lift))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }
  function probe(url) {
    if (colors.has(url)) return Promise.resolve(colors.get(url));
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 4) return Promise.resolve(null);
    const work = new Promise((resolve) => {
      const image = new Image();
      let timer;
      const finish = (color) => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        image.src = "";
        resolve(color);
      };
      image.crossOrigin = "anonymous";
      image.referrerPolicy = "no-referrer";
      image.onload = () => {
        try {
          finish(sample(image));
        } catch {
          finish(null);
        }
      };
      image.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), 5000);
      image.src = url;
    }).then((color) => {
      pending.delete(url);
      colors.set(url, color);
      if (colors.size > 64) colors.delete(colors.keys().next().value);
      return color;
    });
    pending.set(url, work);
    return work;
  }
  function clear(stage) {
    generations.set(stage, {});
  }
  function apply(stage, url) {
    const generation = {};
    generations.set(stage, generation);
    if (!url) return;
    probe(url).then((color) => {
      if (color && generations.get(stage) === generation)
        stage.style.setProperty("--oaccent", color);
    });
  }
  root.SongOverlayPalette = { apply, clear };
})(window);
