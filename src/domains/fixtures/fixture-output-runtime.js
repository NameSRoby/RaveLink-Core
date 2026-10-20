/** Core composition boundary for all fixture state writes.
 * Raw adapters stay private here. Public adapter facades resolve current registry
 * targets, then enter the same broker lane used by temporary programs. No audio
 * capability or timer starts on construction. See docs/DEVELOPMENT.md#fixture-output-ownership.
 */
const createOwnership = require("./fixture-output-ownership.service");
const { isDeepStrictEqual } = require("node:util");
const normalizeState = require("./fixture-output-state");

module.exports = function createFixtureOutputRuntime({ fixtureRegistry, adapters, ...options }) {
  let fixtures = new Map(),
    identities = new Map(),
    ambiguous = new Set();
  const fault = (code) => Object.assign(new Error(code), { code });
  function target(id) {
    if (ambiguous.has(id)) throw fault("fixture_transport_ambiguous");
    const fixture = fixtures.get(id);
    if (!fixture) throw fault("fixture_not_eligible");
    return fixture;
  }
  const ownership = createOwnership({
    ...options,
    isEligible: (id) => fixtures.has(id),
    readState: async (id) => {
      const fixture = target(id),
        adapter = adapters[fixture.brand];
      // Lack of a genuine restorable native read is an explicit admission failure.
      // In particular, the alpha Govee probe currently normalizes missing fields.
      if (!adapter?.readState) return { ok: false, error: "fixture_native_state_unavailable" };
      return adapter.readState(fixture);
    },
    writeState: (id, state) => {
      const fixture = target(id);
      return adapters[fixture.brand].sendState([fixture], state);
    },
    restoreState: async (id, state) => {
      const fixture = target(id),
        adapter = adapters[fixture.brand];
      // Hue may reject brightness/color writes while a bulb is already off.
      // An off/dim scene often leaves its original off-state untouched. Verify
      // exact native equality before skipping a redundant restore; never turn
      // the bulb on just to obtain an acknowledgement, or assume it matches.
      if (fixture.brand === "hue" && state.on === false && adapter.readState) {
        try {
          const actual = await adapter.readState(fixture);
          if (
            actual?.ok === true &&
            isDeepStrictEqual(normalizeState(actual.state, true), normalizeState(state, true))
          )
            return { sent: 1, failed: 0, verifiedUnchanged: true };
        } catch {}
      }
      return (adapter.restoreState || adapter.sendState)([fixture], state);
    },
  });
  function reconcile() {
    const next = new Map();
    const eligible = fixtureRegistry.listConfigured
      ? fixtureRegistry.listConfigured()
      : ["listEngineBy", "listTwitchBy", "listCustomBy"].flatMap(
          (mode) => fixtureRegistry[mode]?.("", "all") || [],
        );
    for (const fixture of eligible)
      if (adapters[fixture.brand]?.sendState) next.set(fixture.id, fixture);
    // Two registry IDs must not create two independent lanes for one bulb.
    // Fail closed on an ambiguous transport rather than pick a routing winner.
    const physical = new Map();
    ambiguous = new Set();
    for (const [id, fixture] of next) {
      const address =
        fixture.brand === "hue"
          ? fixture.bridgeIp && fixture.lightId
            ? `hue:${fixture.bridgeIp}:${fixture.lightId}`
            : null
          : fixture.ip
            ? `${fixture.brand}:${fixture.ip}`
            : null;
      if (!address) continue;
      if (physical.has(address)) {
        ambiguous.add(id);
        ambiguous.add(physical.get(address));
      } else physical.set(address, id);
    }
    for (const id of ambiguous) next.delete(id);
    const nextIdentities = new Map();
    for (const [id, fixture] of next) {
      // Private identity only: never return credentials in broker diagnostics.
      const identity = JSON.stringify([
        fixture.brand,
        fixture.ip,
        fixture.port,
        fixture.bridgeIp,
        fixture.username,
        fixture.clientKey,
        fixture.lightId,
        fixture.entertainmentAreaId,
        fixture.enabled,
        fixture.engineEnabled,
        fixture.twitchEnabled,
        fixture.customEnabled,
      ]);
      nextIdentities.set(id, identity);
      if (identities.has(id) && identities.get(id) !== identity) ownership.removeFixture(id);
    }
    for (const id of fixtures.keys()) if (!next.has(id)) ownership.removeFixture(id);
    fixtures = next;
    identities = nextIdentities;
  }
  reconcile();
  const unsubscribe = fixtureRegistry.subscribe(reconcile);
  async function manual(brand, rows, state) {
    const ids = [...new Set((Array.isArray(rows) ? rows : []).map((row) => row?.id))];
    const deliveries = await Promise.all(
      ids.map(async (id) => {
        try {
          if (target(id).brand !== brand) throw fault("fixture_brand_mismatch");
          return await ownership.manualWrite(id, state);
        } catch (error) {
          return { sent: 0, failed: 1, code: error.code || "fixture_output_failed" };
        }
      }),
    );
    return {
      sent: deliveries.reduce((sum, row) => sum + row.sent, 0),
      failed: deliveries.reduce((sum, row) => sum + row.failed, 0),
      dryRun: deliveries.length > 0 && deliveries.every((row) => row.dryRun === true),
      deliveries,
      ...(deliveries.find((row) => row.command)?.command
        ? { command: deliveries.find((row) => row.command).command }
        : {}),
    };
  }
  const facades = Object.fromEntries(
    Object.entries(adapters).map(([brand, adapter]) => [
      brand,
      Object.freeze({
        ...adapter,
        sendState: (rows, state) => manual(brand, rows, state),
        restoreState: (rows, state) => manual(brand, rows, state),
      }),
    ]),
  );
  return Object.freeze({
    adapters: facades,
    ownership,
    closeAdmission: ownership.closeAdmission,
    diagnostics() {
      const snapshot = ownership.snapshot();
      return {
        mode: "fixture-leases",
        closed: snapshot.closed,
        ownedFixtures: snapshot.fixtures.length,
        ambiguousFixtures: ambiguous.size,
        queue: snapshot.queue,
        lastFaultCode: snapshot.lastFault?.code || null,
      };
    },
    async shutdown() {
      unsubscribe();
      return ownership.shutdown();
    },
  });
};
