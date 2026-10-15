const path = require('node:path');
module.exports = function createManager({ rootDir, runtimeDir, getBridge, installer: suppliedInstaller }) {
  const installer = suppliedInstaller || require('../../../../integrations/tidal-desktop/installer.cjs');
  return function manage(payload, caller) {
    if (caller.featureId !== 'song-request') return { ok: false, error: 'tidal_companion_denied' };
    try {
      if (!['status', 'install', 'update', 'uninstall'].includes(payload?.action)) return { ok: false, error: 'tidal_companion_action_invalid' };
      const resources = installer.discover()[0];
      if (!resources) return { ok: payload.action === 'status', available: false, installed: false, error: 'Regular TIDAL Desktop installation not found.' };
      if (payload.action === 'status') return { ok: true, available: true, ...installer.inspect(resources) };
      if (['install', 'update'].includes(payload.action) && !getBridge()) return { ok: false, error: 'Select TIDAL in the Player before installing the companion.' };
      const args = { resources, pairingFile: path.join(runtimeDir, 'experimental-tidal-pairing.json'),
        coreUrl: payload.coreUrl || 'http://127.0.0.1:5050', bundle: path.join(rootDir, 'integrations/tidal-desktop/dist') };
      // Both operations validate ownership and require TIDAL closed. If the new
      // install fails, uninstall has left the untouched original app restored.
      if (payload.action === 'update') { installer.uninstall(args); return installer.install(args); }
      return installer[payload.action](args);
    } catch (error) { return { ok: false, error: String(error.message).slice(0, 120) }; }
  };
};
