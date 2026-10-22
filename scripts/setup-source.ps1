param(
  [switch]$NoStart,
  [string]$ReleaseArchive = ""
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
try {
  if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw "Use a Windows 10 or 11 x64 PC. Native ARM64 is not currently supported."
  }
  $spec = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-runtime.json') -Raw | ConvertFrom-Json
  if ($spec.version -notmatch '^\d+\.\d+\.\d+[a-z]?$' -or
      $spec.asset -cne "RaveLink-Core-Windows-v$($spec.version)-self-contained.zip" -or
      $spec.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid source runtime manifest.' }
  $cache = Join-Path $root 'runtime\source-setup'
  $stamp = Join-Path $cache 'ready.json'
  $node = Join-Path $root 'runtime\RaveLink-Core-Node.exe'
  $probe = Join-Path $root 'runtime\music-to-light\cargo\release\ravelink-audio-probe.exe'
  $lockHash = (Get-FileHash -LiteralPath (Join-Path $root 'package-lock.json') -Algorithm SHA256).Hash
  $ready = $false
  if (Test-Path -LiteralPath $stamp) {
    $state = Get-Content -LiteralPath $stamp -Raw | ConvertFrom-Json
    $ready = $state.lock -eq $lockHash -and $state.archive -eq $spec.sha256 -and
      (Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $probe) -and
      (Test-Path -LiteralPath (Join-Path $root 'node_modules\express\package.json'))
  }
  if (!$ready) {
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $archive = Join-Path $cache $spec.asset
    if ($ReleaseArchive) {
      $archive = (Resolve-Path -LiteralPath $ReleaseArchive).Path
    } elseif (!(Test-Path -LiteralPath $archive)) {
      Write-Host '[SETUP] Downloading the official Windows runtime (about 43 MB)...'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $download = "$archive.part"
      $previousProgress = $ProgressPreference
      try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/NameSRoby/RaveLink-Core/releases/download/v$($spec.version)/$($spec.asset)" -OutFile $download
        Move-Item -LiteralPath $download -Destination $archive -Force
      } finally { $ProgressPreference = $previousProgress }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $spec.sha256) {
      throw "Runtime checksum mismatch. No downloaded code was run. Remove the cached archive in runtime/source-setup and try again."
    }
    Write-Host '[SETUP] Verified archive. Preparing runtime and audio capture...'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stage = Join-Path $cache ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
      foreach ($entry in $zip.Entries) {
        # Strip the archive's leading ./ and copy only runtime dependencies.
        $relative = $entry.FullName -replace '^[^/]+/', ''
        if ($relative -notmatch '^(node_modules/|runtime/RaveLink-Core-Node\.exe$|runtime/music-to-light/cargo/release/ravelink-audio-probe\.exe$|runtime/NODE-LICENSE\.txt$|package-lock\.json$)') { continue }
        $destination = [IO.Path]::GetFullPath((Join-Path $stage $relative))
        if (!$destination.StartsWith("$stage\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path.' }
        if ($entry.FullName.EndsWith('/')) { continue }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
      }
    } finally { $zip.Dispose() }
    $stagedNode = Join-Path $stage 'runtime\RaveLink-Core-Node.exe'
    # A runtime from another dependency graph must never silently satisfy this source tree.
    & $stagedNode (Join-Path $PSScriptRoot 'verify-source-runtime.js') $root $stage
    if ($LASTEXITCODE -ne 0) { throw 'The pinned runtime does not match this source lockfile. See README for developer setup.' }
    foreach ($directory in @('node_modules', 'runtime')) {
      Copy-Item -LiteralPath (Join-Path $stage $directory) -Destination $root -Recurse -Force
    }
    @{ lock = $lockHash; archive = $spec.sha256 } | ConvertTo-Json | Set-Content -LiteralPath $stamp -Encoding UTF8
    # Only this generated staging directory is removed, never application settings.
    if (![IO.Path]::GetFullPath($stage).StartsWith("$cache\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
  $hostStamp = Join-Path $cache 'host.sha256'
  $hostHash = (@('desktop\windows-host\RaveLinkCoreHost.cs', 'desktop\windows-host\app.manifest', 'assets\RaveLink-Core.ico', 'scripts\build-windows-host.ps1') | ForEach-Object {
    (Get-FileHash -LiteralPath (Join-Path $root $_) -Algorithm SHA256).Hash
  }) -join ':'
  if (!(Test-Path -LiteralPath (Join-Path $root 'RaveLink-Core.exe')) -or
      !(Test-Path -LiteralPath $hostStamp) -or (Get-Content -LiteralPath $hostStamp -Raw).Trim() -ne $hostHash) {
    & (Join-Path $PSScriptRoot 'build-windows-host.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Windows launcher build failed. Exit Core before rebuilding changed launcher sources.' }
    Set-Content -LiteralPath $hostStamp -Value $hostHash -Encoding ASCII
  }
  Write-Host '[SETUP] Ready. Node, production dependencies and audio capture are included. Optional packages can be installed from Packages.'
  if (!$NoStart) { Start-Process -FilePath (Join-Path $root 'RaveLink-Core.exe') -WorkingDirectory $root -WindowStyle Hidden }
} catch {
  Write-Host "[SETUP] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
