/** Optional private-IPv4 gateway to the existing loopback operator surface.
 * No listener exists until enabled; proxy destinations never come from clients.
 */
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { isIP } = require("node:net");
const normalize = (ip = "") => ip.replace(/^::ffff:/, "");
function privateAddress(ip) {
  if (isIP(normalize(ip)) !== 4) return false;
  const values = normalize(ip).split(".").map(Number);
  if (values.length !== 4 || values.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return (
    values[0] === 10 ||
    (values[0] === 172 && values[1] >= 16 && values[1] <= 31) ||
    (values[0] === 192 && values[1] === 168) ||
    (values[0] === 169 && values[1] === 254)
  );
}
function addresses(interfaces) {
  return [
    ...new Set(
      Object.values(interfaces())
        .flat()
        .filter(
          (row) =>
            row &&
            !row.internal &&
            (row.family === "IPv4" || row.family === 4) &&
            privateAddress(row.address),
        )
        .map((row) => row.address),
    ),
  ].slice(0, 32);
}
const fault = (code) => Object.assign(Error(code), { code });
function validate(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["enabled", "port"].includes(key)) ||
    typeof value.enabled !== "boolean" ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535
  )
    throw fault("network_sharing_invalid");
  return { enabled: value.enabled, port: value.port };
}
module.exports = function networkSharing({
  runtimeDir,
  corePort = 5050,
  interfaces = os.networkInterfaces,
} = {}) {
  const file = path.join(runtimeDir, "system", "network-sharing.json");
  let config = { enabled: false, port: corePort >= 1024 && corePort < 65535 ? corePort + 1 : 5051 },
    current = null,
    closing = new Set(),
    error = null,
    closed = false,
    queue = Promise.resolve();
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024) throw fault("network_sharing_invalid");
    config = validate(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {}
  function snapshot() {
    return {
      ok: true,
      enabled: config.enabled,
      active: !!current,
      port: config.port,
      localhost: `http://127.0.0.1:${corePort}/`,
      urls: current ? addresses(interfaces).map((ip) => `http://${ip}:${config.port}/`) : [],
      error,
    };
  }
  function close(entry, grace = 0) {
    if (!entry || entry.done) return entry?.done || Promise.resolve();
    closing.add(entry);
    entry.done = new Promise((resolve) => {
      let timer;
      entry.server.close(() => {
        clearTimeout(timer);
        closing.delete(entry);
        resolve();
      });
      const destroy = () => {
        for (const socket of entry.sockets) socket.destroy();
      };
      if (grace) {
        timer = setTimeout(destroy, grace);
        timer.unref?.();
      } else destroy();
    });
    return entry.done;
  }
  function reject(res, code, reason) {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({ ok: false, error: reason }));
  }
  function handler(port) {
    return (req, res) => {
      const peer = normalize(req.socket.remoteAddress || "");
      const local = peer === "127.0.0.1";
      const host = String(req.headers.host || "");
      const allowed = [...addresses(interfaces), ...(local ? ["127.0.0.1"] : [])].map(
        (ip) => `${ip}:${port}`,
      );
      if ((!local && !privateAddress(peer)) || !allowed.includes(host))
        return reject(res, 403, "private_network_required");
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site")
        return reject(res, 403, "same_origin_required");
      if (!req.url.startsWith("/") || req.url.startsWith("//"))
        return reject(res, 400, "invalid_request_target");
      const headers = { ...req.headers };
      for (const key of Object.keys(headers))
        if (
          [
            "connection",
            "proxy-connection",
            "keep-alive",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "forwarded",
          ].includes(key) ||
          key.startsWith("x-forwarded-")
        )
          delete headers[key];
      const upstream = http.request(
        { host: "127.0.0.1", port: corePort, method: req.method, path: req.url, headers },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
          response.on("error", () => res.destroy());
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) reject(res, 502, "core_unavailable");
        else res.destroy();
      });
      req.on("aborted", () => upstream.destroy());
      req.on("error", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    };
  }
  async function listen(port) {
    if (port === corePort) throw fault("network_sharing_port_conflict");
    const entry = { server: http.createServer(handler(port)), sockets: new Set(), done: null };
    entry.server.on("connection", (socket) => {
      entry.sockets.add(socket);
      socket.on("close", () => entry.sockets.delete(socket));
    });
    entry.server.requestTimeout = 120000;
    entry.server.headersTimeout = 15000;
    entry.server.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise((resolve, rejectListen) => {
      const failure = (reason) => {
        entry.server.removeListener("listening", success);
        rejectListen(reason);
      };
      const success = () => {
        entry.server.removeListener("error", failure);
        resolve();
      };
      entry.server.once("error", failure);
      entry.server.once("listening", success);
      entry.server.listen(port, "0.0.0.0");
    });
    entry.server.on("error", (reason) => {
      error = reason.code || "network_sharing_failed";
    });
    return entry;
  }
  function serial(work) {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  }
  return {
    snapshot,
    activate(port = corePort) {
      return serial(async () => {
        if (closed) return;
        corePort = port;
        if (!config.enabled || current) return;
        try {
          current = await listen(config.port);
          error = null;
        } catch (reason) {
          error = reason.code || "network_sharing_failed";
        }
      });
    },
    configure(input, port = corePort) {
      return serial(async () => {
        if (closed) throw fault("network_sharing_closed");
        corePort = port;
        const next = validate(input);
        let replacement = null;
        if (next.enabled && (!current || next.port !== config.port))
          replacement = await listen(next.port);
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file + ".tmp", JSON.stringify(next) + "\n");
          fs.renameSync(file + ".tmp", file);
        } catch (reason) {
          await close(replacement);
          throw reason;
        }
        const previous = current;
        current = next.enabled ? replacement || current : null;
        config = next;
        error = null;
        if (previous && previous !== current) void close(previous, 200);
        return snapshot();
      });
    },
    async stop() {
      closed = true;
      await queue;
      const entries = [...closing, current].filter(Boolean);
      current = null;
      for (const entry of entries) for (const socket of entry.sockets) socket.destroy();
      await Promise.all(entries.map((entry) => close(entry)));
    },
  };
};
module.exports.privateAddress = privateAddress;
