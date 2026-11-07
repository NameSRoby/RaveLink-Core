/** Local OBS password uses Windows user protection, never deck/browser storage. */
const fs = require("node:fs"),
  path = require("node:path");
const fault = (code) => Object.assign(Error(code), { code });
const validHost = (value) =>
  typeof value === "string" &&
  (value === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(value) ||
    /^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(value)) &&
  (value === "localhost" || value.split(".").every((n) => Number(n) <= 255));
module.exports = function obsSettings(
  runtimeDir,
  codec = require("../../shared/security/windows-dpapi"),
) {
  const file = path.join(runtimeDir, "system", "obs-control.vault.json");
  let value = { host: "127.0.0.1", port: 4455, enabled: false, cipher: "" },
    password = "";
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw Error();
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !validHost(saved.host) ||
      !Number.isInteger(saved.port) ||
      saved.port < 1 ||
      saved.port > 65535 ||
      typeof saved.cipher !== "string"
    )
      throw Error();
    value = {
      host: saved.host,
      port: saved.port,
      enabled: saved.enabled === true,
      cipher: saved.cipher,
    };
    if (value.cipher) {
      const plain = codec.unprotectTextMapWithWindowsDpapi({ obs: value.cipher });
      if (!plain.ok || typeof plain.plain?.obs !== "string") {
        value.enabled = false;
      } else password = Buffer.from(plain.plain.obs, "base64").toString("utf8");
    }
  } catch {
    /* Fresh setup; no plaintext fallback. */
  }
  const publicValue = () => ({
    host: value.host,
    port: value.port,
    enabled: value.enabled,
    hasPassword: !!value.cipher,
  });
  return {
    publicValue,
    connection: () => ({ ...publicValue(), password }),
    save(input) {
      if (
        !input ||
        Object.keys(input).some((k) => !["host", "port", "password", "enabled"].includes(k)) ||
        !validHost(input.host) ||
        !Number.isInteger(input.port) ||
        input.port < 1 ||
        input.port > 65535 ||
        typeof input.enabled !== "boolean" ||
        (input.password !== undefined &&
          (typeof input.password !== "string" || input.password.length > 1024))
      )
        throw fault("obs_settings_invalid");
      const nextPassword =
        input.password ?? (input.host === value.host && input.port === value.port ? password : "");
      let cipher = "";
      if (nextPassword) {
        const encrypted = codec.protectTextMapWithWindowsDpapi({
          obs: Buffer.from(nextPassword, "utf8").toString("base64"),
        });
        if (!encrypted.ok) throw fault("obs_password_storage_failed");
        cipher = encrypted.encrypted.obs;
      }
      const next = { host: input.host, port: input.port, enabled: input.enabled, cipher };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(next) + "\n", { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
      value = next;
      password = nextPassword;
      return publicValue();
    },
  };
};
