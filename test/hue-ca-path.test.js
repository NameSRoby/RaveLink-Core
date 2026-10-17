const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const resolve = require("../src/adapters/brands/hue-ca-path");

test("Hue transports share override/dependency/application-root certificate precedence", () => {
  const packagePath = path.resolve("dependency", "hue-sync", "package.json");
  const packageCert = path.join(path.dirname(packagePath), "signify.pem");
  const root = path.resolve("application");
  const rootCert = path.join(root, "node_modules", "hue-sync", "signify.pem");
  const override = path.resolve("operator-cert.pem");
  const options = {
    env: { RAVE_HUE_CA_CERT_PATH: `  ${override} ` },
    resolvePackage: () => packagePath,
    exists: () => true,
  };
  assert.equal(resolve(root, options), override);
  assert.equal(resolve(root, { ...options, exists: (file) => file !== override }), packageCert);
  assert.equal(
    resolve(root, {
      ...options,
      resolvePackage() {
        throw Error("optional dependency missing");
      },
      exists: (file) => file === rootCert,
    }),
    rootCert,
  );
  assert.equal(resolve(root, { ...options, exists: () => false }), "");
});
