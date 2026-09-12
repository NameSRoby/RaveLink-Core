param(
  [ValidateSet("tidal", "spotify", "apple-music")]
  [string]$Provider = "tidal",
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$SourcePatterns = @{
  "tidal" = "tidal"
  "spotify" = "spotify"
  "apple-music" = "apple.*music|music.*apple"
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime]

function Await-WinRt {
  param($Operation, [Type]$ResultType)
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.GetAwaiter().GetResult()
}

function Find-MediaSession {
  param($Manager)
  $pattern = $SourcePatterns[$Provider]
  @($Manager.GetSessions()) |
    Where-Object { [string]$_.SourceAppUserModelId -match $pattern } |
    Sort-Object { if ([string]$_.GetPlaybackInfo().PlaybackStatus -eq "Playing") { 0 } else { 1 } } |
    Select-Object -First 1
}

function Get-MediaSnapshot {
  param($Session)
  if ($null -eq $Session) {
    return [ordered]@{ schemaVersion = 2; available = $false; source = $Provider }
  }
  $media = Await-WinRt $Session.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $Session.GetPlaybackInfo()
  $timeline = $Session.GetTimelineProperties()
  return [ordered]@{
    schemaVersion = 2
    available = $true
    source = $Session.SourceAppUserModelId
    title = [string]$media.Title
    artist = [string]$media.Artist
    album = [string]$media.AlbumTitle
    status = [string]$playback.PlaybackStatus
    positionMs = [long]$timeline.Position.TotalMilliseconds
    durationMs = [long]$timeline.EndTime.TotalMilliseconds
    observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$snapshot = Get-MediaSnapshot (Find-MediaSession $manager)
$snapshot | ConvertTo-Json -Compress
if ($Once) { exit 0 }

$initialPositionBucket = if ($snapshot.available -and $snapshot.status -eq "Playing") { [long]($snapshot.positionMs / 2000) } else { [long]$snapshot.positionMs }
$lastFingerprint = @($snapshot.available, $snapshot.title, $snapshot.artist, $snapshot.album, $snapshot.status, $initialPositionBucket, $snapshot.durationMs) -join "|"
while ($true) {
  try {
    $snapshot = Get-MediaSnapshot (Find-MediaSession $manager)
    $positionBucket = if ($snapshot.available -and $snapshot.status -eq "Playing") { [long]($snapshot.positionMs / 2000) } else { [long]$snapshot.positionMs }
    $fingerprint = @($snapshot.available, $snapshot.title, $snapshot.artist, $snapshot.album, $snapshot.status, $positionBucket, $snapshot.durationMs) -join "|"
    if ($fingerprint -ne $lastFingerprint) {
      $snapshot.observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $snapshot | ConvertTo-Json -Compress
      $lastFingerprint = $fingerprint
    }
  } catch {
    $unavailable = [ordered]@{ schemaVersion = 2; available = $false; source = $Provider }
    if ($lastFingerprint -ne "unavailable") {
      $unavailable | ConvertTo-Json -Compress
      $lastFingerprint = "unavailable"
    }
  }
  Start-Sleep -Milliseconds 1000
}
