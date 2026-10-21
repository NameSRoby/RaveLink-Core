/** Bridge HTTPS uses Hue's certified bridge identity, not its LAN IP as a DNS name.
 * Older saved fixtures may lack that identity. Resolve public metadata without
 * credentials, then require the Signify chain and matching peer certificate.
 */
const https = require("node:https"),
  tls = require("node:tls"),
  fs = require("node:fs");
const resolveCa = require("./hue-ca-path");
const fault = (code) => Object.assign(Error(code), { code });
module.exports = function createEntertainmentHttp({ http, timeoutMs, rootDir }) {
  const certPath = resolveCa(rootDir);
  const bridgeIds = new Map();
  async function bridgeId(c, signal) {
    const known = c.bridgeId || bridgeIds.get(c.bridgeIp);
    if (known) {
      if (!/^[a-f\d]{16}$/i.test(known)) throw fault("hue_entertainment_bridge_identity_missing");
      return known.toUpperCase();
    }
    const response = await http.request({
      url: `http://${c.bridgeIp}/api/config`,
      method: "GET",
      timeout: Math.min(timeoutMs, 2400),
      signal,
      maxRedirects: 0,
      maxContentLength: 256 * 1024,
    });
    const id = response.data?.bridgeid;
    if (typeof id !== "string" || !/^[a-f\d]{16}$/i.test(id))
      throw fault("hue_entertainment_bridge_identity_missing");
    if (bridgeIds.size >= 64) bridgeIds.delete(bridgeIds.keys().next().value);
    bridgeIds.set(c.bridgeIp, id.toUpperCase());
    return id.toUpperCase();
  }
  return async function request(c, version, resource, body, signal) {
    let agent;
    try {
      const legacyHttp = version === 1 && c.forceHttp === true;
      if (!legacyHttp) {
        const identity = await bridgeId(c, signal);
        agent = new https.Agent({
          rejectUnauthorized: true,
          ...(certPath ? { ca: fs.readFileSync(certPath) } : {}),
          servername: identity,
          checkServerIdentity: (_host, cert) => tls.checkServerIdentity(identity, cert),
        });
      }
      const prefix = legacyHttp
        ? `http://${c.bridgeIp}/api/${c.username}/`
        : version === 1
          ? `https://${c.bridgeIp}/api/${c.username}/`
          : `https://${c.bridgeIp}/`;
      const response = await http.request({
        url: prefix + resource,
        method: body ? "PUT" : "GET",
        data: body,
        timeout: Math.min(timeoutMs, 2400),
        signal,
        httpsAgent: agent,
        headers: { "hue-application-key": c.username },
        maxRedirects: 0,
        maxContentLength: 512 * 1024,
      });
      const data = response.data;
      if (data?.errors?.length || (Array.isArray(data) && data.some((r) => r.error)))
        throw fault("hue_entertainment_bridge_rejected");
      return data;
    } catch (error) {
      if (error.code?.startsWith("hue_")) throw error;
      if (error.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        bridgeIds.delete(c.bridgeIp);
        throw fault("hue_entertainment_bridge_identity_mismatch");
      }
      const code = ["ECONNABORTED", "ETIMEDOUT"].includes(error.code)
        ? "bridge_timeout"
        : error.code === "ERR_CANCELED"
          ? "cancelled"
          : ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code)
            ? "bridge_unreachable"
            : /CERT|SELF_SIGNED|VERIFY_LEAF/.test(error.code || "")
              ? "certificate_failed"
              : "bridge_request_failed";
      throw fault("hue_entertainment_" + code);
    } finally {
      agent?.destroy();
    }
  };
};
