/**
 * Third-party mod permissions adapt the shared supervisor's flag builder.
 * Preserve the mod platform's default read root and explicitly deny native addon
 * grants, including unvalidated input. Features can use the generic policy's
 * addon support; mods cannot acquire it by passing an unexpected manifest field.
 */
const path = require("node:path");
const {
  buildProcessPermissions,
  detectPermissionSupport,
} = require("../../supervised-runtime/host/process-permissions");
function buildModProcessPermissions(options = {}) {
  const manifest = options.manifest || {};
  return buildProcessPermissions({
    ...options,
    platformRoot: options.platformRoot || path.join(__dirname, ".."),
    manifest: { ...manifest, permissions: { ...manifest.permissions, nativeAddons: false } },
  });
}
module.exports = { buildModProcessPermissions, detectPermissionSupport };
