const path = require('node:path');
const companionRoot = require('../src/shared/packages/resolve-tidal-companion')(path.resolve(__dirname,'..'));
const installer = require(path.join(companionRoot,'installer.cjs'));
const args = process.argv.slice(2), mode = args[0] || 'status';
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
try {
  if (!['status', 'install', 'uninstall'].includes(mode)) throw new Error('Use status, install, or uninstall.');
  const resources = option('--resources', installer.discover()[0]);
  if (!resources) throw new Error('Regular TIDAL Desktop not found. Use --resources with its resources directory.');
  const result = mode === 'status' ? installer.inspect(resources) : installer[mode]({ resources,
    pairingFile: option('--pairing-file', path.resolve(__dirname, '../runtime/experimental-tidal-pairing.json')),
    coreUrl: option('--core-url', 'http://127.0.0.1:5050') });
  console.log(JSON.stringify(result, null, 2));
  if (mode === 'install') console.log('Start TIDAL normally, then refresh the TIDAL Player status in RaveLink.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
