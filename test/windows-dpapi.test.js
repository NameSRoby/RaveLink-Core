const test = require("node:test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test(
  "Windows DPAPI works with an inherited incompatible module path",
  { skip: process.platform !== "win32" },
  () => {
    const script = `
    const assert = require('node:assert/strict');
    const vault = require(process.argv[1]);
    const encrypted = vault.protectTextMapWithWindowsDpapi({ value: 'regression-fixture' });
    assert.equal(encrypted.ok, true, encrypted.error);
    const plain = vault.unprotectTextMapWithWindowsDpapi(encrypted.encrypted);
    assert.equal(plain.ok, true, plain.error);
    assert.equal(plain.plain.value, 'regression-fixture');
  `;
    execFileSync(
      process.execPath,
      ["-e", script, path.resolve(__dirname, "../src/shared/security/windows-dpapi")],
      {
        env: {
          ...process.env,
          PSModulePath: path.join(__dirname, "nonexistent-powershell-modules"),
        },
        stdio: "pipe",
        windowsHide: true,
      },
    );
  },
);
