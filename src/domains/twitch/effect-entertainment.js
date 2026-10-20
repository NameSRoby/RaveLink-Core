/** Gate one dynamic effect's frames on its server-owned Entertainment lifetime. */
module.exports = function createEffectEntertainment({ adapter, active }) {
  const owners = new Map();
  async function release(sessionId) {
    if ([...active.values()].some((entry) => entry.sessionId === sessionId)) return;
    const owner = owners.get(sessionId);
    if (!owner) return;
    owners.delete(sessionId);
    await adapter?.stopEntertainment?.(owner);
  }
  return {
    release,
    decorateState(state, entry) {
      if (entry?.entertainmentActive) state.__entertainment = true;
    },
    restore(entry, options, restoreEntry) {
      if (!owners.has(entry.sessionId)) return restoreEntry(entry, options);
      return release(entry.sessionId).then(() => {
        if (!owners.has(entry.sessionId)) entry.entertainmentActive = false;
        return restoreEntry(entry, options);
      });
    },
    guardDelivery(delivery, entry, stop) {
      if (!entry?.entertainmentActive) return delivery;
      return Promise.resolve(delivery).catch((error) => {
        stop();
        throw error;
      });
    },
    async prepare(entries, sessionId) {
      if (!adapter?.prepareEntertainment) return null;
      await Promise.all([...owners.keys()].map(release));
      const owner = `core.effects.${sessionId}`;
      owners.set(sessionId, owner);
      let result;
      try {
        result = await adapter.prepareEntertainment(
          entries.map((entry) => entry.fixture),
          owner,
        );
      } catch {
        result = { ok: false, error: "hue_entertainment_preheat_failed" };
      }
      if (result.ok)
        entries.forEach((entry) => {
          entry.entertainmentActive = result.activeIds?.includes(entry.fixture.id) === true;
        });
      return result;
    },
  };
};
