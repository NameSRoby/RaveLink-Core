const path = require("node:path");
const createProcessSupervisor = require("../../supervised-runtime/host/process-supervisor");
const { validateManifestV1 } = require("../contracts/mod-manifest-v1");
const { buildModProcessPermissions } = require("./mod-process-permissions");

module.exports = function createModProcessSupervisor(options = {}) {
  return createProcessSupervisor({
    ...options,
    workloadKind: "mod",
    displayName: "Mod",
    identityField: "modId",
    statusIdentityField: "modId",
    configArgument: "--ravelink-mod-config=",
    apiMajor: 1,
    validateManifest: manifest => validateManifestV1(manifest, { modApiMajor: 1 }),
    buildPermissions: permissionOptions => buildModProcessPermissions({
      ...permissionOptions,
      additionalReadRoots: [path.join(__dirname, "..", "..", "supervised-runtime")]
    }),
    platformRoot: options.platformRoot || path.join(__dirname, ".."),
    bootstrapPath: options.bootstrapPath || path.join(__dirname, "..", "runtime", "mod-worker-bootstrap.js")
  });
};
