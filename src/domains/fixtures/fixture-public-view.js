/** Fixture browser DTOs never expose bridge credentials or streaming keys. */
function publicFixture(fixture = {}) {
  const storedRange = fixture.extras?.colorTemperatureMired;
  const brand = String(fixture.brand || "");
  const temperatureMinimum =
    brand === "hue" && Number(storedRange?.maximum) > 0
      ? Math.round(1000000 / Number(storedRange.maximum))
      : brand === "wiz"
        ? 2200
        : 2000;
  const temperatureMaximum =
    brand === "hue" && Number(storedRange?.minimum) > 0
      ? Math.round(1000000 / Number(storedRange.minimum))
      : brand === "wiz"
        ? 6500
        : 9000;
  return {
    id: String(fixture.id || ""),
    name: String(fixture.name || fixture.id || ""),
    brand,
    zone: String(fixture.zone || ""),
    enabled: fixture.enabled !== false,
    engineEnabled: fixture.engineEnabled === true,
    twitchEnabled: fixture.twitchEnabled === true,
    customEnabled: fixture.customEnabled === true,
    lightId: Number(fixture.lightId || 0),
    bridgeIpConfigured: Boolean(fixture.bridgeIp),
    deviceIpConfigured: Boolean(fixture.ip),
    entertainmentConfigured: Boolean(
      fixture.entertainmentAreaId && /^[a-f\d]{32}$/i.test(fixture.clientKey || ""),
    ),
    credentialsConfigured: Boolean(fixture.username || fixture.clientKey),
    temperatureRange: {
      minimumKelvin: temperatureMinimum,
      maximumKelvin: temperatureMaximum,
    },
  };
}

function editableFixture(fixture = {}) {
  return {
    id: String(fixture.id || ""),
    name: String(fixture.name || fixture.id || ""),
    brand: String(fixture.brand || ""),
    zone: String(fixture.zone || ""),
    enabled: fixture.enabled !== false,
    engineEnabled: fixture.engineEnabled === true,
    twitchEnabled: fixture.twitchEnabled === true,
    customEnabled: fixture.customEnabled === true,
    bridgeIp: String(fixture.bridgeIp || ""),
    ip: String(fixture.ip || ""),
    lightId: Number(fixture.lightId || 0),
    entertainmentAreaId: String(fixture.entertainmentAreaId || ""),
    clientKeyConfigured: /^[a-f\d]{32}$/i.test(fixture.clientKey || ""),
  };
}

module.exports = { publicFixture, editableFixture };
