/** Explicit local-operator setup; never runs during startup or a LAN request. */
const path = require("node:path");
const { execFile } = require("node:child_process");
module.exports = function createWindowsFirewall({
  rootDir,
  platform = process.platform,
  run = execFile,
}) {
  let pending;
  return {
    configure() {
      if (platform !== "win32")
        return Promise.reject(
          Object.assign(Error("windows_required"), { code: "windows_required" }),
        );
      if (pending) return pending;
      const shell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      pending = new Promise((resolve, reject) =>
        run(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(rootDir, "scripts/configure-windows-firewall.ps1"),
            "-Action",
            "Apply",
          ],
          { windowsHide: true, timeout: 120000, maxBuffer: 16384 },
          (error) => {
            if (error)
              reject(
                Object.assign(Error("firewall_setup_cancelled_or_failed"), {
                  code: "firewall_setup_cancelled_or_failed",
                }),
              );
            else resolve({ ok: true, configured: true });
          },
        ),
      ).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
};
