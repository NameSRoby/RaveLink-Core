const fs=require('node:fs');
const path=require('node:path');
// Windows updates already manage packages/. Source checkouts retain integrations/.
module.exports = root => {
  const packaged=path.join(root,'packages/tidal-desktop');
  return fs.existsSync(path.join(packaged,'installer.cjs'))?packaged:path.join(root,'integrations/tidal-desktop');
};
