/** Synthetic extension peer over authenticated loopback HTTP; never contacts YouTube. */
const crypto = require("node:crypto");
module.exports = async function youtubeBrowserFixture(provider, options = {}) {
  const connection = await provider.handle("setup", { action: "start", port: 0 });
  if (!connection.ok) throw Error(connection.error);
  const base = `http://127.0.0.1:${connection.port}`;
  const clientId = "fixture-browser";
  const documentId = crypto.randomUUID();
  let serial = 0,
    pending = null,
    polling = false,
    lastError = null;
  const commands = [],
    rows = [
      { videoId: "aaaaaaaaaaa", occurrenceId: "native:current", selected: true },
      { videoId: "bbbbbbbbbbb", occurrenceId: "native:personal", selected: false },
    ];
  const post = async (route, value) => {
    const result = await fetch(base + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + connection.pairingCode,
      },
      body: JSON.stringify(value),
    });
    return result.json();
  };
  await post("/api/pair", { clientId });
  let paused = true;
  const snapshot = () => ({
    current: {
      videoId: rows.find((row) => row.selected)?.videoId || "aaaaaaaaaaa",
      title: "Fixture song",
      artist: "Demo artist",
    },
    paused,
    position: 10,
    duration: 180,
    volume: 40,
    mediaReady: true,
    ad: false,
    nextAvailable: true,
    queue: rows.map((row) => ({
      ...row,
      title: "Fixture song",
      artist: "Demo artist",
      identityKind: "native",
    })),
    queueComplete: true,
    native: {
      available: true,
      documentId,
      queueRead: true,
      queueWrite: true,
      requestInsertion: true,
      network: true,
      player: true,
      allIdentified: true,
      queueSize: rows.length,
      compatibility: {
        contract: "ytmusic-services-v1",
        queueReady: true,
        blocked: false,
        reasons: [],
      },
    },
  });
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const sent = pending;
      const response = await post("/api/exchange", {
        clientId,
        snapshot: snapshot(),
        ...(sent ? { result: sent } : {}),
      });
      if (sent && response.ack === sent.id) pending = null;
      const command = response.command;
      if (!command) return;
      commands.push(command);
      if (options.ignoreCommands) return;
      const result = { ok: true, id: command.id, sessionId: command.sessionId };
      if (command.action === "append") {
        const row = {
          videoId: command.videoId,
          occurrenceId: "native:request-" + ++serial,
          selected: false,
        };
        const anchor = command.afterOccurrenceId
          ? rows.findIndex((item) => item.occurrenceId === command.afterOccurrenceId) + 1
          : rows.length;
        rows.splice(anchor, 0, row);
        Object.assign(result, {
          occurrenceId: row.occurrenceId,
          videoId: row.videoId,
          nativeDocumentId: documentId,
        });
      } else if (command.action === "remove") {
        const index = rows.findIndex((row) => row.occurrenceId === command.occurrenceId);
        if (index >= 0) rows.splice(index, 1);
      } else if (command.action === "skip") {
        const index = rows.findIndex((row) => row.selected);
        if (index + 1 < rows.length) {
          rows[index].selected = false;
          rows[index + 1].selected = true;
        }
      } else if (command.action === "pause") paused = true;
      else if (command.action === "resume") paused = false;
      pending = result;
    } catch (error) {
      lastError = error;
    } finally {
      polling = false;
    }
  }
  await poll();
  const timer = setInterval(() => void poll(), 20);
  return {
    commands,
    rows,
    connection,
    poll,
    play(uid) {
      for (const row of rows) row.selected = row.occurrenceId === uid;
      paused = false;
    },
    async close() {
      clearInterval(timer);
      while (polling) await new Promise((resolve) => setTimeout(resolve, 5));
      if (lastError) throw lastError;
    },
  };
};
