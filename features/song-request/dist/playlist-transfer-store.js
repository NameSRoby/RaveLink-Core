/**
 * Paged transfer persistence and its commit point.
 * Save row pages before publishing the job index. Five-row pages bound matched-track
 * metadata within IPC frames; throttled bursts respect host storage call budgets.
 * The index count describes the complete stored row inventory. Loading a missing or
 * inconsistent page must not silently invent tracks or resume remote writes.
 */
module.exports = function transferStore(context) {
  const call = (method, key, value) =>
    context.callCapability(
      "ravelink.storage.v1",
      method,
      { key, ...(value === undefined ? {} : { value }) },
      { timeoutMs: 5000 },
    );
  async function set(key, value) {
    const result = await call("set", key, value);
    if (result?.ok === false) throw new Error("transfer_storage_failed");
  }
  return {
    async load() {
      const index = await call("get", "playlist-transfer-v1");
      if (!index?.found || !index.value || index.value.version !== 1) return null;
      const job = index.value,
        rows = [];
      if (
        !Number.isInteger(job.count) ||
        job.count < 0 ||
        job.count > 10000 ||
        !/^[a-f0-9-]{36}$/.test(job.id)
      )
        throw new Error("transfer_storage_invalid");
      for (let page = 0; page < Math.ceil(job.count / 5); page++) {
        const stored = await call("get", "transfer-" + job.id + "-" + page);
        if (!stored?.found || !Array.isArray(stored.value))
          throw new Error("transfer_storage_invalid");
        rows.push(...stored.value);
        if (page % 80 === 79) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (rows.length !== job.count) throw new Error("transfer_storage_invalid");
      return { job, rows };
    },
    index: (job) => {
      job.revision = (job.revision || 0) + 1;
      return set("playlist-transfer-v1", job);
    },
    page: (job, rows, offset) =>
      set(
        "transfer-" + job.id + "-" + Math.floor(offset / 5),
        rows.slice(Math.floor(offset / 5) * 5, Math.floor(offset / 5) * 5 + 5),
      ),
    async save(job, rows) {
      for (let offset = 0; offset < rows.length; offset += 5) {
        await this.page(job, rows, offset);
        if (offset % 400 === 395) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await this.index(job);
    },
    async remove(job) {
      if (!job) return;
      for (let page = 0; page < Math.ceil(job.count / 5); page++) {
        await call("remove", "transfer-" + job.id + "-" + page);
        if (page % 40 === 39) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    },
  };
};
