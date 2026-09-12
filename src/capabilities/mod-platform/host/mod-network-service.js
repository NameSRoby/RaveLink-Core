// [TITLE] Module: capabilities/mod-platform/host/mod-network-service.js
// [TITLE] Purpose: provide exact-host bounded HTTPS without granting raw mod networking
// [TITLE] Functionality Index:
// [TITLE] - authorize declared public DNS hosts and reject raw/private targets
// [TITLE] - pin validated DNS answers into TLS requests and deny redirects
// [TITLE] - enforce request, response, deadline, and per-mod concurrency limits

const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const BLOCKED_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4]
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED_ADDRESSES.check(address, "ipv4");
  if (family === 6) {
    const value = address.toLowerCase().split("%")[0];
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
    return !BLOCKED_ADDRESSES.check(value, "ipv6");
  }
  return false;
}

function parseDeclaredHost(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!HOST_RE.test(text) || net.isIP(text)) return null;
  const colon = text.lastIndexOf(":");
  const hasPort = colon > text.lastIndexOf(".");
  return { declared: text, hostname: hasPort ? text.slice(0, colon) : text, port: hasPort ? Number(text.slice(colon + 1)) : 443 };
}

function normalizedPath(value) {
  const text = String(value || "");
  if (!text.startsWith("/") || text.includes("\\") || text.includes("\0") || text.includes("://")) return "";
  if (/%(?:2e|2f|5c)/i.test(text)) return "";
  if (text.split(/[/?#]/).some(segment => segment === "." || segment === "..")) return "";
  let parsed;
  try { parsed = new URL(text, "https://placeholder.invalid"); } catch { return ""; }
  if (parsed.origin !== "https://placeholder.invalid") return "";
  const segments = parsed.pathname.split("/");
  if (segments.some(segment => segment === ".." || segment === ".")) return "";
  return `${parsed.pathname}${parsed.search}`.slice(0, 2048);
}

async function defaultTransport(request, context) {
  const answers = await dns.promises.lookup(request.hostname, { all: true, verbatim: true });
  const answer = answers.find(row => isPublicAddress(row.address));
  if (!answer || answers.some(row => !isPublicAddress(row.address))) throw new Error("network_private_address_denied");
  return await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: request.hostname,
      port: request.port,
      path: request.path,
      method: request.method,
      headers: request.headers,
      servername: request.hostname,
      timeout: context.timeoutMs,
      lookup: (_hostname, _options, callback) => callback(null, answer.address, answer.family)
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error("network_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const status = Number(response.statusCode || 0);
        if (status >= 300 && status < 400) return reject(new Error("network_redirect_denied"));
        const body = Buffer.concat(chunks).toString("utf8");
        const contentType = String(response.headers["content-type"] || "");
        let data = body;
        if (contentType.includes("json") && body) {
          try { data = JSON.parse(body); } catch { return reject(new Error("network_invalid_json")); }
        }
        resolve({ status, data, bytes });
      });
    });
    req.on("timeout", () => req.destroy(new Error("network_timeout")));
    req.on("error", reject);
    if (context.signal) context.signal.addEventListener("abort", () => req.destroy(new Error("network_cancelled")), { once: true });
    if (request.body.length) req.write(request.body);
    req.end();
  });
}

module.exports = function createModNetworkService(options = {}) {
  const transport = typeof options.transport === "function" ? options.transport : defaultTransport;
  const egressGovernor = options.egressGovernor && typeof options.egressGovernor.run === "function"
    ? options.egressGovernor
    : null;
  const inFlight = new Map();

  async function request(manifest, input = {}, context = {}) {
    const modId = String(manifest?.id || "");
    const target = parseDeclaredHost(input.host);
    const declared = (manifest?.permissions?.network || []).map(parseDeclaredHost).filter(Boolean);
    if (!target || !declared.some(row => row.declared === target.declared)) return { ok: false, error: "network_permission_denied" };
    const method = String(input.method || "GET").toUpperCase();
    const requestPath = normalizedPath(input.path);
    if (!METHODS.has(method) || !requestPath) return { ok: false, error: "network_request_invalid" };
    const headers = { accept: "application/json", "user-agent": "RaveLink-Mod-Gateway/1" };
    if (input.contentType === "application/json") headers["content-type"] = "application/json";
    let body = Buffer.alloc(0);
    if (input.body !== undefined && method !== "GET") {
      try { body = Buffer.from(JSON.stringify(input.body), "utf8"); } catch { return { ok: false, error: "network_request_invalid" }; }
      if (body.length > MAX_REQUEST_BYTES) return { ok: false, error: "network_request_too_large" };
    }
    const limit = Math.min(2, Math.max(0, Number(manifest?.resources?.externalInFlight) || 0));
    const active = inFlight.get(modId) || 0;
    if (!limit) return { ok: false, error: "network_budget_disabled" };
    if (active >= limit) return { ok: false, error: "network_busy" };
    inFlight.set(modId, active + 1);
    try {
      const timeoutMs = Math.min(30000, Math.max(250, Number(context.timeoutMs) || 8000));
      const operation = () => transport({ ...target, path: requestPath, method, headers, body }, { timeoutMs, signal: context.signal });
      const result = egressGovernor
        ? await egressGovernor.run({ owner: "mod.network", priority: "optional", queueDeadlineMs: timeoutMs }, operation)
        : await operation();
      let responseBytes;
      try { responseBytes = Buffer.byteLength(JSON.stringify(result.data ?? null), "utf8"); } catch { return { ok: false, error: "network_response_invalid" }; }
      if (responseBytes > MAX_RESPONSE_BYTES) return { ok: false, error: "network_response_too_large" };
      return { ok: true, status: Number(result.status || 0), data: result.data, bytes: Number(result.bytes || 0) };
    } catch (error) {
      const code = String(error?.message || "network_failed");
      if (code === "egress_queue_full") return { ok: false, error: "network_busy" };
      if (code === "egress_queue_expired") return { ok: false, error: "network_timeout" };
      if (code === "egress_shutdown") return { ok: false, error: "network_unavailable" };
      return { ok: false, error: /^network_[a-z_]+$/.test(code) ? code : "network_failed" };
    } finally {
      const remaining = (inFlight.get(modId) || 1) - 1;
      if (remaining) inFlight.set(modId, remaining); else inFlight.delete(modId);
    }
  }

  return Object.freeze({ request });
};

module.exports.isPublicAddress = isPublicAddress;
module.exports.normalizedPath = normalizedPath;
module.exports.parseDeclaredHost = parseDeclaredHost;
