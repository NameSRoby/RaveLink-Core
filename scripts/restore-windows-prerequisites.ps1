$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSpec = Get-Content -LiteralPath (Join-Path $taskRoot 'desktop\windows-host\prerequisites.json') -Raw | ConvertFrom-Json
$taskCache = Join-Path $taskRoot 'runtime\build\prerequisites'
New-Item -ItemType Directory -Force -Path $taskCache | Out-Null
foreach ($taskEntry in $taskSpec.PSObject.Properties) {
  $taskPackage = $taskEntry.Value
  if ($taskPackage.file -notmatch '^[A-Za-z0-9.-]+\.exe$' -or $taskPackage.sha256 -notmatch '^[a-f0-9]{64}$' -or
      $taskPackage.url -notmatch '^https://msedge\.sf\.dl\.delivery\.mp\.microsoft\.com/') { throw 'Invalid prerequisite manifest.' }
  $taskFile = Join-Path $taskCache $taskPackage.file
  $taskValid = (Test-Path -LiteralPath $taskFile) -and
    (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash -ieq $taskPackage.sha256
  if (!$taskValid) {
    $taskPartial = $taskFile + '.partial'
    Write-Host "[SETUP] Downloading $($taskPackage.description) for offline distribution..."
    Invoke-WebRequest -UseBasicParsing -Uri $taskPackage.url -OutFile $taskPartial
    if ((Get-FileHash -LiteralPath $taskPartial -Algorithm SHA256).Hash -ine $taskPackage.sha256) {
      throw 'Prerequisite checksum mismatch. Nothing was executed.'
    }
    Move-Item -LiteralPath $taskPartial -Destination $taskFile -Force
  }
  $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskFile
  if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
    throw 'Prerequisite Microsoft signature verification failed. Nothing was executed.'
  }
  if ((Get-Item -LiteralPath $taskFile).Length -ne $taskPackage.size) { throw 'Prerequisite size mismatch.' }
  Write-Host "[SETUP] Verified offline prerequisite: $($taskPackage.file)"
}
