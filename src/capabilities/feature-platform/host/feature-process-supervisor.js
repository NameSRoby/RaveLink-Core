const path = require("node:path");
const createProcessSupervisor = require("../../supervised-runtime/host/process-supervisor");
const { buildProcessPermissions } = require("../../supervised-runtime/host/process-permissions");
const { validateFeatureManifestV1 } = require("../contracts/feature-manifest-v1");

module.exports = function createFeatureProcessSupervisor(options = {}) {
  return createProcessSupervisor({
    ...options,
    workloadKind: "feature",
    displayName: "Feature",
    identityField: "featureId",
    statusIdentityField: "featureId",
    apiMajor: 1,
    validateManifest: validateFeatureManifestV1,
    buildPermissions: permissionOptions => buildProcessPermissions({
      ...permissionOptions,
      additionalReadRoots: [path.join(__dirname, "..", "..", "supervised-runtime")]
    }),
    platformRoot: options.platformRoot || path.join(__dirname, "..", "..", "supervised-runtime"),
    bootstrapPath: options.bootstrapPath || path.join(__dirname, "..", "..", "supervised-runtime", "runtime", "worker-bootstrap.js")
  });
};
