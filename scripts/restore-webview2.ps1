param([string]$Destination = "")
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
$root = Split-Path -Parent $PSScriptRoot
$spec = Get-Content -LiteralPath (Join-Path $root 'desktop\windows-host\webview2-sdk.json') -Raw | ConvertFrom-Json
$cache = Join-Path $root ("runtime\build\webview2-sdk\" + $spec.version)
if (!$Destination) { $Destination = Join-Path $root 'runtime\desktop' }
New-Item -ItemType Directory -Path $cache, $Destination -Force | Out-Null
$complete = $true
foreach ($file in $spec.files.PSObject.Properties) {
  $installed = Join-Path $Destination $file.Name
  if (!(Test-Path -LiteralPath $installed) -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ine $file.Value.sha256) { $complete = $false; break }
}
if ($complete) { Write-Host "[DESKTOP] WebView2 SDK $($spec.version) verified."; return }
$package = Join-Path $cache 'microsoft.web.webview2.nupkg'
if (!(Test-Path -LiteralPath $package)) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $partial = $package + '.part'
  $previousProgress = $ProgressPreference
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$($spec.version)/microsoft.web.webview2.$($spec.version).nupkg" -OutFile $partial
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $spec.sha256) { throw 'WebView2 SDK checksum mismatch.' }
    Move-Item -LiteralPath $partial -Destination $package -Force
  } finally {
    $ProgressPreference = $previousProgress
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  }
}
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ine $spec.sha256) { throw 'Cached WebView2 SDK checksum mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
  foreach ($file in $spec.files.PSObject.Properties) {
    $entry = $archive.GetEntry($file.Value.entry)
    if (!$entry) { throw "WebView2 SDK is missing $($file.Name)" }
    $destinationFile = Join-Path $Destination $file.Name
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destinationFile, $true)
    if ((Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash -ine $file.Value.sha256) { throw 'WebView2 extracted dependency checksum mismatch.' }
  }
  foreach ($name in @('lib/net462/Microsoft.Web.WebView2.Core.xml', 'lib/net462/Microsoft.Web.WebView2.WinForms.xml')) {
    [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry($name), (Join-Path $cache ([IO.Path]::GetFileName($name))), $true)
  }
} finally { $archive.Dispose() }
Write-Host "[DESKTOP] WebView2 SDK $($spec.version) verified."
