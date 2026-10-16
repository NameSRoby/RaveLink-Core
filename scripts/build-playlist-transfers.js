const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../features/song-request/ui');
const file = path.join(root, 'server-playlist.html');
const source = ['provider-marks.js', 'playlist-provider-ui.js', 'playlist-transfer-flow.js', 'playlist-browser.js', 'playlist-link-imports.js', 'playlist-workspace.js', 'playlist-match-review.js', 'playlist-community.js', 'playlist-transfers.js'].map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
const html = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(file, html.replace(/\/\/ PLAYLIST_TRANSFERS_BEGIN\n[\s\S]*?\/\/ PLAYLIST_TRANSFERS_END/, () => '// PLAYLIST_TRANSFERS_BEGIN\n' + source.replace(/\r\n/g, '\n') + '\n// PLAYLIST_TRANSFERS_END'));
