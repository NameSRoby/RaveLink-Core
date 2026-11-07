# Core-owned Windows audio bridge. Structured data only; never records audio.
param([switch]$SelfTest)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'windows-audio-control.cs')
function Write-AudioResult($Value){[Console]::WriteLine(($Value | ConvertTo-Json -Depth 10 -Compress))}
if($SelfTest){Write-AudioResult @{ok=$true;pointerSize=[IntPtr]::Size};exit 0}
Write-AudioResult @{ready=$true}
while($null -ne ($line=[Console]::ReadLine())){
  $message=$null
  try{
    if($line.Length -gt 16384){throw 'audio_command_invalid'}
    $message=$line | ConvertFrom-Json
    if("$($message.id)" -notmatch '^\d{1,12}$'){throw 'audio_command_invalid'}
    if($message.operation -eq 'audio.status'){$value=[RaveLink.WindowsAudio.Control]::Read()}
    elseif($message.operation -eq 'audio.set'){
      $payload=$message.payload
      if($payload.target -notmatch '^(system|microphone|(?:device|app):[a-f0-9]{64})$' -or $payload.action -notin @('volume','mute','toggle-mute')){throw 'audio_command_invalid'}
      if($payload.action -eq 'volume' -and ($payload.level -isnot [int] -or $payload.level -lt 0 -or $payload.level -gt 100)){throw 'audio_command_invalid'}
      if($payload.action -eq 'mute' -and $payload.muted -isnot [bool]){throw 'audio_command_invalid'}
      $value=[RaveLink.WindowsAudio.Control]::Apply([string]$payload.target,[string]$payload.action,[int]$payload.level,[bool]$payload.muted)
    }else{throw 'audio_command_invalid'}
    Write-AudioResult @{id="$($message.id)";ok=$true;value=$value}
  }catch{
    $taskError=$_.Exception
    while($taskError.InnerException){$taskError=$taskError.InnerException}
    $code=$taskError.Message
    if($code -notmatch '^audio_[a-z_]{1,60}$'){$code='audio_device_unavailable'}
    Write-AudioResult @{id="$($message.id)";ok=$false;code=$code}
  }
}
