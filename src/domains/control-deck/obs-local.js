/** Explicitly import this Windows user's existing OBS connection, never edit OBS. */
const fs = require("node:fs"),
  path = require("node:path");
module.exports = function obsLocal(
  configure,
  filename = process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "obs-studio", "plugin_config", "obs-websocket", "config.json")
    : null,
) {
  function read() {
    try {
      if (!filename) return null;
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) return null;
      const v = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (!Number.isInteger(v.server_port) || v.server_port < 1 || v.server_port > 65535)
        return null;
      return v;
    } catch {
      return null;
    }
  }
  return {
    status() {
      const v = read();
      return {
        found: !!v,
        serverEnabled: v?.server_enabled === true,
        port: v?.server_port || 4455,
      };
    },
    async connect() {
      const v = read();
      if (!v || v.server_enabled !== true)
        throw Object.assign(Error("obs_enable_websocket_in_obs"), {
          code: "obs_enable_websocket_in_obs",
        });
      if (
        v.auth_required === true &&
        (typeof v.server_password !== "string" ||
          !v.server_password ||
          v.server_password.length > 1024)
      )
        throw Object.assign(Error("obs_password_required"), { code: "obs_password_required" });
      return configure({
        host: "127.0.0.1",
        port: v.server_port,
        password: v.auth_required === true ? v.server_password : "",
        enabled: true,
      });
    },
  };
};
