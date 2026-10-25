/** Small changed pages stay below the supervised IPC frame budget. */
module.exports = function outcomeStorage(context, key) {
  const cached = new Map();
  let count = -1,
    saving = Promise.resolve();
  const call = async (method, payload) => {
    const result = await context.callCapability("ravelink.storage.v1", method, payload, {
      timeoutMs: 2000,
    });
    if (result?.ok === false) throw Error("reward_outcome_storage_failed");
    return result;
  };
  async function load() {
    const result = await call("get", { key });
    if (Array.isArray(result?.value)) return result.value.slice(-1000);
    const pages = result?.value?.pages ?? 0;
    if (!Number.isInteger(pages) || pages < 0 || pages > 40)
      throw Error("reward_outcome_storage_invalid");
    const rows = [];
    for (let index = 0; index < pages; index++) {
      const page = await call("get", { key: key + "-" + index });
      if (!Array.isArray(page?.value) || page.value.length > 25)
        throw Error("reward_outcome_storage_invalid");
      rows.push(...page.value);
      cached.set(index, JSON.stringify(page.value));
    }
    count = pages;
    return rows;
  }
  function store(entries) {
    saving = saving
      .catch(() => {})
      .then(async () => {
        const rows = [...entries.values()],
          pages = Math.ceil(rows.length / 25);
        for (let index = 0; index < pages; index++) {
          const value = rows.slice(index * 25, index * 25 + 25),
            encoded = JSON.stringify(value);
          if (cached.get(index) === encoded) continue;
          await call("set", { key: key + "-" + index, value });
          cached.set(index, encoded);
        }
        if (count !== pages) {
          await call("set", { key, value: { pages } });
          count = pages;
        }
      });
    return saving;
  }
  return { load, store };
};
