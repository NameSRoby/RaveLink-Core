param(
  [ValidateSet('Plan', 'Apply', 'Remove')][string]$Action = 'Plan',
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskProgram = Join-Path $taskRoot 'runtime\RaveLink-Core-Node.exe'
if ($Action -ne 'Plan' -and !(Test-Path -LiteralPath $taskProgram -PathType Leaf)) { throw 'Bundled RaveLink runtime not found.' }
$taskHash = [Security.Cryptography.SHA256]::Create()
try { $taskId = [BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskProgram.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) } finally { $taskHash.Dispose() }
$taskName = 'RaveLink.Core.Private.' + $taskId
if ($Action -eq 'Plan') {
  @{ name = $taskName; program = $taskProgram; direction = 'Inbound'; profile = 'Private'; remoteAddress = 'LocalSubnet'; action = 'Allow' } | ConvertTo-Json -Compress
  exit 0
}
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($Action -eq 'Apply') {
  try {
  $taskExisting = Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue
  $taskAllows = @(Get-NetFirewallApplicationFilter -Program $taskProgram -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
  $taskReady = $taskExisting -and ($taskAllows.Name -contains $taskName) -and $taskExisting.Enabled -eq 'True' -and $taskExisting.Profile -eq 'Private' -and $taskExisting.EdgeTraversalPolicy -eq 'Block'
  foreach ($taskRule in $taskAllows) {
    $taskAddresses = @($taskRule | Get-NetFirewallAddressFilter | Select-Object -ExpandProperty RemoteAddress)
    if ($taskRule.Profile -ne 'Private' -or $taskAddresses.Count -ne 1 -or $taskAddresses[0] -ne 'LocalSubnet') { $taskReady = $false }
  }
  if ($taskReady) { @{ ok = $true; configured = $true; unchanged = $true } | ConvertTo-Json -Compress; exit 0 }
  } catch { # Reading firewall policy may itself require elevation on managed PCs.
  }
}
$taskPrincipal = New-Object Security.Principal.WindowsPrincipal($taskIdentity)
if (!$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($Elevated) { throw 'Windows administrator approval is required.' }
  $taskShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  $taskArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action {1} -Elevated' -f $PSCommandPath, $Action
  $taskChild = Start-Process -FilePath $taskShell -ArgumentList $taskArguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($taskChild.ExitCode -ne 0) { throw 'Windows could not configure private network access.' }
  @{ ok = $true; configured = ($Action -eq 'Apply') } | ConvertTo-Json -Compress
  exit 0
}
if ($Action -eq 'Remove') {
  Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
} else {
  $taskRule = Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue
  if (!$taskRule) {
    New-NetFirewallRule -Name $taskName -DisplayName 'RaveLink Core - local private network' -Group 'RaveLink Core' -Program $taskProgram -Direction Inbound -Action Allow -Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
  } else {
    $taskRule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Private -RemoteAddress LocalSubnet -Program $taskProgram -EdgeTraversalPolicy Block
  }
  # Narrow prior Allow-access exceptions for this exact runtime. User Block rules stay intact.
  Get-NetFirewallApplicationFilter -Program $taskProgram | Get-NetFirewallRule | Where-Object { $_.Name -ne $taskName -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | ForEach-Object {
    $_ | Set-NetFirewallRule -Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block
  }
}
@{ ok = $true; configured = ($Action -eq 'Apply') } | ConvertTo-Json -Compress
