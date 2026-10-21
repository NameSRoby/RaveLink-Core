/** Replay analyzed features through the production mapper and native brightness
 * quantization. No capture, network, ownership or device I/O is performed here.
 * Geometry is route position, not a claim about room dimensions or bulb nits.
 */
const createMapper = require("./mapper.cjs");
const createCadence = require("./output-cadence.cjs");
const createOutputMotion = require("./output-motion.cjs");
const { opening, choose: chooseTransitions } = require("./lifecycle-motion.cjs");
const { sceneFrame } = require("./fixture-behavior.cjs");
function simulate({ features, fixtures, design, random = () => 0.5, history = null }) {
  const mapper = createMapper(design, { random, history });
  const effective = mapper.settings();
  const transitionPlan = chooseTransitions(effective.behaviors, random, history);
  fixtures = require("./fixture-contrast.cjs").plan(
    require("./recipe.cjs").fixtures(
      fixtures,
      effective,
      true,
      random,
      effective.behaviors.expressiveEnabled && effective.behaviors.shuffleChoicesEnabled
        ? history
        : null,
    ),
  );
  mapper.setPositions(require("./composition.cjs").reactivePositions(fixtures));
  const cadence = createCadence(fixtures),
    motion = createOutputMotion(),
    sentAt = new Map(),
    previous = [];
  const frames = [];
  let lastOutput = null;
  let origin = null;
  for (let index = 0; index < features.length; index++) {
    const item = features[index];
    const event = item.event || item;
    const sampledAt = event.endFrame / 48;
    mapper.update(event, sampledAt);
    const rate =
      transitionPlan.openingStyle && sampledAt - (origin ?? sampledAt) < transitionPlan.openingMs
        ? effective.outputHz
        : cadence.rate(effective, mapper.inspect(sampledAt), sampledAt);
    // Render deadlines are independent of the 20 ms analyzer cadence. Render
    // with the newest available sample, never a future sample or a catch-up burst.
    const at = lastOutput === null ? sampledAt : Math.max(sampledAt, lastOutput + 1000 / rate);
    const nextItem = features[index + 1];
    const nextSampleAt = nextItem ? (nextItem.event || nextItem).endFrame / 48 : sampledAt + 1;
    if (at >= nextSampleAt) continue;
    const rendered = fixtures.map((f, i) => {
      const frame = mapper.render(at, {
        ...f,
        onsetSince: Math.max(sentAt.get(i) ?? at - 1, at - cadence.retentionMs(f, rate)),
      });
      if (!frame) return null;
      let result = sceneFrame(
        f,
        frame,
        effective,
        { on: true, bri: 127, dimming: 50 },
        at - (origin ?? at),
      );
      if (!f.raveBehavior || f.raveBehavior === "reactive")
        result = motion.render(i, result, at, effective);
      result = opening(
        result,
        f,
        effective,
        at - (origin ?? at),
        {
          on: true,
          bri: 127,
          dimming: 50,
        },
        transitionPlan,
      );
      // Without a native snapshot, dim/off use an explicitly illustrative
      // neutral starting color at 50%. Never present this as measured room state.
      if (["dim", "off"].includes(f.raveBehavior)) result.rgb = { r: 255, g: 255, b: 255 };
      return result;
    });
    if (rendered.some((f) => !f)) continue;
    origin ??= at;
    frames.push({
      at,
      ...(frames.length ? {} : { recipe: mapper.inspect(at).recipe }),
      lights: rendered.map((f, i) => {
        const scale = fixtures[i].brand === "hue" ? 2.54 : 1;
        const minimum = Math.ceil(effective.minimumBrightness * scale);
        const maximum = Math.floor(effective.maximumBrightness * scale);
        const result = {
          rgb: f.rgb,
          brightness:
            f.sceneNative?.on === false
              ? 0
              : f.sceneNative
                ? f.brightness
                : Math.max(minimum, Math.min(maximum, Math.round(f.brightness * scale))) / scale,
        };
        if (previous[i] && at - sentAt.get(i) < 1000 / cadence.fixtureRate(fixtures[i], rate))
          return previous[i];
        sentAt.set(i, at);
        previous[i] = result;
        return result;
      }),
    });
    lastOutput = at;
  }
  return frames;
}
module.exports = { simulate };
