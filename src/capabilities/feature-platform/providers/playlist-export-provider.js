const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
module.exports = function playlistExports({ root, openFolder } = {}) {
  const folder = path.resolve(root); let upload = null;
  async function files() {
    await fs.mkdir(folder, { recursive: true });
    const rows = [];
    for (const name of await fs.readdir(folder)) {
      if (!/^[a-zA-Z0-9_-]+\.csv$/.test(name)) continue;
      const stat = await fs.lstat(path.join(folder, name));
      if (stat.isFile() && !stat.isSymbolicLink()) rows.push({ name, bytes: stat.size, savedAt: stat.mtimeMs });
    }
    return rows.sort((a, b) => b.savedAt - a.savedAt);
  }
  async function clear() { if (upload) { await upload.handle.close(); await fs.unlink(upload.path).catch(() => {}); upload = null; } }
  async function action(input = {}) {
    try {
      if (input.action === 'list') return { ok: true, folder, files: (await files()).slice(0, 50) };
      if (input.action === 'open') {
        await fs.mkdir(folder, { recursive: true });
        if (openFolder) await openFolder(folder);
        else {
          if (process.platform !== 'win32') throw new Error('exports_folder_open_unavailable');
          await new Promise((resolve, reject) => { const child = require('node:child_process').spawn('explorer.exe', [folder], { shell: false, windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', resolve); child.unref(); });
        }
        return { ok: true, folder };
      }
      if (input.action === 'begin') {
        const saved = await files();
        if (saved.length >= 200 || saved.reduce((sum, row) => sum + row.bytes, 0) >= 134217728) throw new Error('exports_folder_full');
        if (upload && Date.now() - upload.at < 300000) throw new Error('export_busy');
        await clear();
        const id = crypto.randomUUID(), slug = String(input.name || 'playlist').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'playlist';
        const temporary = path.join(folder, id + '.part');
        upload = { id, path: temporary, name: slug + '-' + id + '.csv', handle: await fs.open(temporary, 'wx'), offset: 0, bytes: 0, remaining: 134217728 - saved.reduce((sum, row) => sum + row.bytes, 0), at: Date.now() };
        return { ok: true, id };
      }
      if (!upload || input.id !== upload.id || Date.now() - upload.at > 300000) throw new Error('export_expired');
      if (input.action === 'cancel') { await clear(); return { ok: true }; }
      if (input.action === 'append') {
        if (typeof input.chunk !== 'string' || input.chunk.length > 24000 || input.offset !== upload.offset) throw new Error('export_chunk_invalid');
        const bytes = Buffer.byteLength(input.chunk);
        if (upload.bytes + bytes > 8388608) throw new Error('export_file_limit');
        if (upload.bytes + bytes > upload.remaining) throw new Error('exports_folder_full');
        await upload.handle.writeFile(input.chunk, 'utf8'); upload.offset += input.chunk.length; upload.bytes += bytes; upload.at = Date.now();
        return { ok: true };
      }
      if (input.action === 'finish') {
        await upload.handle.sync(); await upload.handle.close();
        const file = { name: upload.name, bytes: upload.bytes, savedAt: Date.now() };
        await fs.rename(upload.path, path.join(folder, file.name)); upload = null;
        return { ok: true, folder, file };
      }
      throw new Error('export_action_invalid');
    } catch (error) { return { ok: false, code: /^export/.test(error.message) ? error.message : 'export_file_failed' }; }
  }
  return { action };
};
