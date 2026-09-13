param(
  [ValidateSet("Apply", "Rollback")][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$HostPid = 0,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$updateRoot = Join-Path $rootPath "runtime\updates"
$stagedStatePath = Join-Path $updateRoot "staged.json"
$pendingPath = Join-Path $updateRoot "pending-health.json"
$availablePath = Join-Path $updateRoot "available-rollback.json"
$logPath = Join-Path $updateRoot "update.log"
$managedDirectories = @("src", "public", "assets", "packages", "node_modules", "scripts", "feature-packages", "optional-components")
$managedFiles = @("package.json", "package-lock.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "RELEASE_BUILD.json", "RaveLink-Core.exe")
$managedRuntimeFiles = @("RaveLink-Core-Node.exe", "NODE-LICENSE.txt")

function Write-UpdateLog([string]$Value) {
  New-Item -ItemType Directory -Force -Path $updateRoot | Out-Null
  Add-Content -LiteralPath $logPath -Value "$([DateTimeOffset]::Now.ToString('o')) $Value" -Encoding UTF8
}

function Read-Json([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing update state: $Path" }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-JsonAtomic([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Assert-ChildPath([string]$Candidate, [string]$Parent) {
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
  $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (!$resolvedCandidate.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe update path: $resolvedCandidate" }
  return $resolvedCandidate
}

function Wait-ForHost {
  if ($HostPid -le 0 -or $HostPid -eq $PID) { return }
  try {
    $hostProcess = Get-Process -Id $HostPid -ErrorAction Stop
    if (!$hostProcess.WaitForExit(30000)) { throw "Windows host did not stop in time" }
  } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
}

function Copy-TreeItem([string]$Source, [string]$Destination) {
  if (!(Test-Path -LiteralPath $Source)) { return }
  $parent = Split-Path -Parent $Destination
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Remove-Managed([string]$Base) {
  foreach ($relative in $managedDirectories + $managedFiles) {
    $target = Join-Path $Base $relative
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
  foreach ($relative in $managedRuntimeFiles) {
    $target = Join-Path $Base "runtime\$relative"
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  }
}

function Copy-Managed([string]$Source, [string]$Destination) {
  foreach ($relative in $managedDirectories + $managedFiles) {
    Copy-TreeItem (Join-Path $Source $relative) (Join-Path $Destination $relative)
  }
  foreach ($relative in $managedRuntimeFiles) {
    Copy-TreeItem (Join-Path $Source "runtime\$relative") (Join-Path $Destination "runtime\$relative")
  }
}

function Start-Core([string]$Argument) {
  if ($NoLaunch) { return }
  $executable = Join-Path $rootPath "RaveLink-Core.exe"
  if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Updated Windows host is missing" }
  Start-Process -FilePath $executable -ArgumentList $Argument -WorkingDirectory $rootPath -WindowStyle Hidden
}

function Restore-Backup($State) {
  $backupPath = Assert-ChildPath "$($State.backupPath)" (Join-Path $updateRoot "rollback")
  if (!(Test-Path -LiteralPath $backupPath -PathType Container)) { throw "Rollback snapshot is missing" }
  Remove-Managed $rootPath
  Copy-Managed $backupPath $rootPath
}

Wait-ForHost
Write-UpdateLog "$Action started"

if ($Action -eq "Rollback") {
  $statePath = if (Test-Path -LiteralPath $pendingPath) { $pendingPath } else { $availablePath }
  $state = Read-Json $statePath
  Restore-Backup $state
  Remove-Item -LiteralPath $pendingPath, $availablePath -Force -ErrorAction SilentlyContinue
  Write-UpdateLog "Restored version $($state.previousVersion)"
  Start-Core "--post-rollback"
  exit 0
}

$staged = Read-Json $stagedStatePath
if ($staged.verified -ne $true -or "$($staged.version)" -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Update is not verified" }
$archivePath = Assert-ChildPath "$($staged.archivePath)" (Join-Path $updateRoot "downloads")
if (!(Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Staged archive is missing" }
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne "$($staged.sha256)".ToLowerInvariant()) { throw "Staged archive checksum changed" }

$extractPath = Join-Path $updateRoot "extract-$($staged.version)-$PID"
$backupPath = Join-Path $updateRoot "rollback\$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"
Assert-ChildPath $extractPath $updateRoot | Out-Null
Assert-ChildPath $backupPath (Join-Path $updateRoot "rollback") | Out-Null
New-Item -ItemType Directory -Force -Path $extractPath, $backupPath | Out-Null

try {
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
  $release = Read-Json (Join-Path $extractPath "RELEASE_BUILD.json")
  if ("$($release.version)" -ne "$($staged.version)" -or "$($release.channel)" -ne "release") { throw "Archive release identity does not match" }
  if (!(Test-Path -LiteralPath (Join-Path $extractPath "src\app\core\create-core-server.js"))) { throw "Archive server entry is missing" }
  if (!(Test-Path -LiteralPath (Join-Path $extractPath "RaveLink-Core.exe"))) { throw "Archive Windows host is missing" }

  $current = if (Test-Path -LiteralPath (Join-Path $rootPath "RELEASE_BUILD.json")) { Read-Json (Join-Path $rootPath "RELEASE_BUILD.json") } else { @{ version = "unknown" } }
  $rollbackRoot = Join-Path $updateRoot "rollback"
  if (Test-Path -LiteralPath $rollbackRoot) { Remove-Item -LiteralPath $rollbackRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
  Copy-Managed $rootPath $backupPath
  $rollback = [ordered]@{
    previousVersion = "$($current.version)"
    updatedVersion = "$($staged.version)"
    backupPath = $backupPath
    createdAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-JsonAtomic $pendingPath $rollback
  Remove-Managed $rootPath
  Copy-Managed $extractPath $rootPath
  Remove-Item -LiteralPath $availablePath -Force -ErrorAction SilentlyContinue
  Write-UpdateLog "Applied version $($staged.version); awaiting health confirmation"
  Start-Core "--post-update"
} catch {
  Write-UpdateLog "Apply failed: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $pendingPath) {
    try { Restore-Backup (Read-Json $pendingPath); Remove-Item -LiteralPath $pendingPath -Force } catch { Write-UpdateLog "Immediate restore failed: $($_.Exception.Message)" }
  }
  Start-Core "--post-rollback"
  throw
} finally {
  Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
}
