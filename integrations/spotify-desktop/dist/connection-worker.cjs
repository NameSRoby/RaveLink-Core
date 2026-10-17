/**
 * Spotify renderer bridge pump and receipt deduplication.
 * Only one step runs at a time. Cache command outcomes by ID/signature and resend
 * a pending receipt after transport failure instead of executing the command again.
 * Read-only history can be evicted; writes cannot be forgotten just to free space.
 * Action timeouts do not cancel native side effects and must remain retry-unsafe.
 */
module.exports = function createSpotifyConnection(client, options = {}) {
  const base = new URL(options.coreUrl || "http://127.0.0.1:5050");
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !/^[a-f0-9]{64}$/.test(options.token || "")
  )
    throw Error("spotify_pairing_invalid");
  const clientId = options.clientId || globalThis.crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) throw Error("spotify_companion_id_invalid");
  const fetchImpl = options.fetch || globalThis.fetch,
    results = new Map();
  let sessionId = "",
    pendingReceipt = null,
    receiptSessionId = "",
    inFlight = null,
    heartbeatWork = null,
    heartbeatAt = 0,
    closed = false,
    lastError = "";
  async function post(method, payload) {
    const body = JSON.stringify({ clientId, sessionId, ...payload });
    if (BufferBytes(body) > 65536) throw Error("spotify_bridge_payload_invalid");
    const response = await fetchImpl(new URL("/api/spotify/bridge/" + method, base), {
      method: "POST",
      headers: {
        authorization: "Bearer " + options.token,
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
    });
    const chunks = [];
    let bytes = 0;
    if (!response.body) throw Error("spotify_bridge_reply_invalid");
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 65536) throw Error("spotify_bridge_reply_invalid");
      chunks.push(chunk);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const reply = JSON.parse(new TextDecoder().decode(joined));
    if (response.status === 409 && reply.error === "spotify_companion_session_required")
      sessionId = "";
    if (!response.ok || reply.ok !== true) {
      const error = Error("spotify_bridge_rejected");
      if (["spotify_companion_session_required", "spotify_result_unknown"].includes(reply.error))
        error.code = reply.error;
      throw error;
    }
    return reply;
  }
  const BufferBytes = (text) => new TextEncoder().encode(text).byteLength;
  async function execute(command) {
    if (
      !command ||
      typeof command.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(command.id) ||
      !/^[a-f0-9]{32}$/.test(command.lease || "") ||
      !["append", "remove", "search", "lookup", "control", "playlist"].includes(command.kind)
    )
      throw Error("spotify_bridge_command_invalid");
    const signature = JSON.stringify([command.kind, command.payload]),
      previous = results.get(command.id);
    if (previous) {
      if (previous.signature !== signature) throw Error("spotify_request_id_conflict");
      if (previous.result?.safeToRetry !== true) return previous.result;
      results.delete(command.id);
    }
    for (const [id, item] of results)
      if (item.kind === "search" || (item.kind === "playlist" && item.readOnly)) results.delete(id);
    if (results.size >= 2048) throw Error("spotify_bridge_history_full");
    let timer;
    const limit = Math.max(50, Math.min(5000, options.actionTimeoutMs || 4000));
    const action = Promise.resolve().then(() =>
      command.kind === "playlist"
        ? client.playlist(command.payload)
        : command.kind === "search"
          ? client.search(command.payload?.query)
          : command.kind === "lookup"
            ? client.lookup(command.payload?.uri)
            : command.kind === "append"
              ? client.append(command.payload?.uri, {
                  uid: command.payload?.uid,
                })
              : command.kind === "control"
                ? client.control(command.payload)
                : client.remove(command.payload),
    );
    let result;
    try {
      result = await Promise.race([
        action,
        new Promise((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                ok: false,
                error:
                  command.kind === "search"
                    ? "spotify_desktop_search_rejected"
                    : "spotify_delivery_unconfirmed",
                retrySafe: false,
              }),
            limit,
          );
        }),
      ]);
    } catch {
      result = {
        ok: false,
        error: "spotify_companion_action_failed",
        retrySafe: false,
      };
    } finally {
      clearTimeout(timer);
    }
    results.set(command.id, {
      signature,
      result,
      kind: command.kind,
      readOnly: ["list", "read"].includes(command.payload?.action),
    });
    return result;
  }
  async function step() {
    if (closed) return;
    try {
      if (!sessionId) {
        sessionId = (await post("hello", {})).sessionId;
        // A restarted host has a new session and cannot accept an old lease.
        // Keep cached outcomes to prevent another native write, but release the
        // obsolete acknowledgement so it cannot block all future polling.
        if (pendingReceipt && receiptSessionId !== sessionId) pendingReceipt = null;
      }
      if (!sessionId) throw Error("spotify_bridge_session_invalid");
      // Only the receipt is retried after a dropped reply, never the native command.
      if (pendingReceipt) {
        await post("result", pendingReceipt);
        pendingReceipt = null;
        lastError = "";
        return;
      }
      const snapshot = client.snapshot?.();
      const { command } = await post("next", snapshot?.ok ? { snapshot } : {});
      if (!command) {
        lastError = "";
        return;
      }
      const commandSessionId = sessionId;
      const result = await execute(command);
      receiptSessionId = commandSessionId;
      pendingReceipt = {
        id: command.id,
        lease: command.lease,
        result,
      };
      await post("result", pendingReceipt);
      pendingReceipt = null;
      lastError = "";
    } catch (error) {
      // Completed read receipts can be evicted by the host before an ACK retry.
      // Never execute the command again just to replace an unknown receipt.
      if (error.code === "spotify_result_unknown") pendingReceipt = null;
      lastError = "spotify_bridge_unavailable";
    }
  }
  return {
    step() {
      // The renderer already ticks once per second. While a native call or ACK
      // is pending, send a separate bounded heartbeat without fetching another
      // command or creating another timer. At most one heartbeat is in flight.
      if (inFlight && !closed && sessionId && !heartbeatWork && Date.now() - heartbeatAt >= 2000) {
        heartbeatAt = Date.now();
        heartbeatWork = post("heartbeat", {})
          .catch(() => {})
          .finally(() => {
            heartbeatWork = null;
          });
      }
      if (!inFlight)
        inFlight = step().finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    status: () => ({
      paired: Boolean(sessionId),
      awaitingReceipt: Boolean(pendingReceipt),
      executed: results.size,
      lastError,
      closed,
    }),
    close() {
      closed = true;
    },
  };
};
