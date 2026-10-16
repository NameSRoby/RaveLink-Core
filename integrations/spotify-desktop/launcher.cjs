const { spawn } = require('node:child_process');
const sidecar = require('./sidecar.cjs');

// All variable data travels on stdin. Never build PowerShell source from paths.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $spotifyLaunchRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if (Get-Process -Name Spotify -ErrorAction SilentlyContinue) { throw 'spotify_close_client_required' }
  $spotifyLaunchExecutable = $spotifyLaunchRequest.executable
  if ($spotifyLaunchRequest.store) {
    $spotifyExpectedAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\Spotify.exe'
    $spotifyResolvedAlias = (Get-Command Spotify.exe -ErrorAction Stop).Source
    if ($spotifyResolvedAlias -ne $spotifyExpectedAlias) { throw 'spotify_store_alias_unavailable' }
    $spotifyLaunchExecutable = 'Spotify.exe'
  }
  $spotifyLaunched = Start-Process -FilePath $spotifyLaunchExecutable -ArgumentList ('--app-directory="' + $spotifyLaunchRequest.apps + '"') -WindowStyle Hidden -PassThru
  @{ ok = $true; launched = $true; launcherPid = $spotifyLaunched.Id; prototype = $true } | ConvertTo-Json -Compress
} catch {
  $spotifyLaunchError = if ($_.Exception.Message -eq 'spotify_close_client_required') { 'spotify_close_client_required' } elseif ($_.Exception.Message -eq 'spotify_store_alias_unavailable') { 'spotify_store_alias_unavailable' } else { 'spotify_launch_failed' }
  @{ ok = $false; error = $spotifyLaunchError } | ConvertTo-Json -Compress
  exit 1
}`;

function execute(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = (error, result) => {
      if (done) return;done = true;clearTimeout(timer);
      child.stdout.destroy();child.stderr.destroy();child.unref();
      if (error) reject(error);else resolve(result);
    };
    const timer = setTimeout(() => { child.kill();finish(Error('spotify_launch_failed')); }, options.timeout);
    child.on('error', error => finish(error));child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => {
      output += bytes.toString('utf8');if (output.length > options.maxBuffer) return finish(Error('spotify_launch_failed'));
      // A Store alias can leave inherited pipes open after PowerShell exits.
      // The explicit launch receipt is sufficient; never wait for Spotify to quit.
      try { const receipt = JSON.parse(output.trim());finish(null, { status: receipt.ok ? 0 : 1, stdout: output }); } catch {}
    });
    child.stderr.resume();child.on('exit', code => { if (!done) finish(null, { status: code, stdout: output }); });
    child.stdin.end(options.input);
  });
}
module.exports = async function launch(runtimeRoot, id, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw Error('spotify_windows_only');
  const plan = sidecar.launchPlan(runtimeRoot, id);
  const store = /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(plan.executable);
  const input = JSON.stringify({ executable: plan.executable, apps: plan.args[0].slice('--app-directory='.length), store });
  const result = await (options.spawn || execute)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { input, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
  let receipt;
  try { receipt = JSON.parse(result.stdout || '{}'); } catch { throw Error('spotify_launch_failed'); }
  if (result.status !== 0 || receipt.ok !== true || receipt.launched !== true || !Number.isSafeInteger(receipt.launcherPid) || receipt.launcherPid <= 0) {
    const known = ['spotify_close_client_required', 'spotify_store_alias_unavailable'];
    throw Error(known.includes(receipt.error) ? receipt.error : 'spotify_launch_failed');
  }
  return { ok: true, launched: true, launcherPid: receipt.launcherPid, prototype: true, runtimeVerified: false };
};
