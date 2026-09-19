const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("release identity is RaveLink Core for Windows 0.6.3", () => {
  const pkg = require("../package.json");
  const shell = fs.readFileSync(path.join(root, "public", "core", "index.html"), "utf8");
  const release = fs.readFileSync(path.join(root, "scripts", "package-release.ps1"), "utf8");
  const installer = fs.readFileSync(path.join(root, "scripts", "build-windows-setup.js"), "utf8");
  const host = fs.readFileSync(path.join(root, "desktop", "windows-host", "RaveLinkCoreHost.cs"), "utf8");
  const twitchClient = require("../src/capabilities/feature-platform/providers/twitch-public-client");

  assert.equal(pkg.name, "ravelink-core");
  assert.equal(pkg.version, "0.6.3-dev");
  assert.match(shell, /<title>RaveLink Core<\/title>/);
  assert.match(shell, /<h1>RAVELINK CORE<\/h1>/);
  assert.match(release, /RaveLink-Core-Windows-v\$Version/);
  assert.match(installer, /RaveLink-Core\.exe/);
  assert.match(release, /RaveLink-Core-Node\.exe/);
  assert.match(host, /RequestStopAsync/);
  assert.match(host, /KillOnJobClose/);
  assert.match(host, /ExtractAssociatedIcon/);
  assert.match(host, /RollbackPendingUpdateAsync/);
  assert.match(installer, /UsePreviousAppDir=yes/);
  assert.match(installer, /ShouldInstallFeature/);
  assert.equal(fs.existsSync(path.join(root, "scripts", "ravelink-update.ps1")), true);
  assert.equal(fs.existsSync(path.join(root, "RaveLink-Core.exe")), true);
  assert.equal(fs.existsSync(path.join(root, "assets", "RaveLink-Core.ico")), true);
  assert.match(installer, /SetupIconFile/);
  assert.match(installer, /RELEASE_NOTES/);
  assert.match(installer, /#define AppName \\\"RaveLink Core\\\"/);
  assert.match(twitchClient.TWITCH_PUBLIC_CLIENT_ID, /^[a-z0-9]{10,80}$/i);
  assert.equal(fs.existsSync(path.join(root, "RaveLink-Core-Start.bat")), true);
  assert.equal(fs.existsSync(path.join(root, "RaveLink-Core-Stop.bat")), true);
  assert.equal(fs.existsSync(path.join(root, "RaveLink-Bridge-Start.bat")), false);
  assert.equal(fs.existsSync(path.join(root, "RaveLink-Bridge-Stop.bat")), false);
});
