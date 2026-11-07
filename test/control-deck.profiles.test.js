const test = require("node:test"),
  assert = require("node:assert/strict");
const catalog = require("../src/domains/control-deck/profile-actions");
const target = (color, extra = {}) => ({
  on: true,
  color,
  mode: "color",
  brightness: 100,
  temperatureKelvin: 3500,
  ...extra,
});
test("profile actions follow saved targets, shared mode and white temperature without machine bindings", () => {
  const profile = {
    id: "room-look",
    name: "Evening",
    strategy: "individual",
    fixtureTargets: {
      first: target("#ff0000"),
      second: target("#0000ff", { brightness: 30 }),
      third: target("#00ff00", { on: false }),
    },
    sharedTarget: target("#aabbcc"),
  };
  const action = catalog([profile])[0];
  assert.equal(action.id, "lighting.profile:room-look");
  assert.equal(action.symbol, "💡");
  assert.equal(action.label, "Evening");
  assert.deepEqual(action.profileLighting, [
    { color: "#ff0000", level: 1 },
    { color: "#0000ff", level: 0.3 },
    { color: "#00ff00", level: 0 },
  ]);
  assert(!JSON.stringify(action).includes('"first"'));
  profile.strategy = "shared";
  assert.deepEqual(
    catalog([profile])[0].profileLighting,
    Array(3).fill({ color: "#aabbcc", level: 1 }),
  );
  profile.sharedTarget = target("#ffffff", { mode: "temperature", temperatureKelvin: 2000 });
  const warm = catalog([profile])[0].profileLighting[0].color;
  profile.sharedTarget.temperatureKelvin = 6500;
  const cool = catalog([profile])[0].profileLighting[0].color;
  assert.notEqual(warm, cool);
  assert.match(warm, /^#[a-f0-9]{6}$/);
  assert.equal(catalog([{ ...profile, fixtureTargets: {} }])[0].available, false);
  profile.name = "Updated look";
  assert.equal(catalog([profile])[0].label, "Updated look");
  assert.deepEqual(catalog([]), []);
});
