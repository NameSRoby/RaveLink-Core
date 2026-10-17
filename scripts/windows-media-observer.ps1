<#
Windows media-session observer: emits bounded JSON lines for one selected provider.
The Node supervisor owns child lifetime, source validation, and forwarding pressure.
Keep stdout UTF-8 JSON only; diagnostic output on stdout would corrupt the protocol.
Track identity and thumbnail arrival are independent. Recheck artwork after a short
bounded cache interval and clear the previous track's image when identity changes.
WinRT async operations are awaited explicitly because Windows PowerShell cannot
directly await their projected interfaces. See docs/DEVELOPMENT.md for the flow.
#>
param(
  [ValidateSet("tidal", "spotify", "apple-music")]
  [string]$Provider = "tidal",
  [switch]$Once
)

# Resolve standard cmdlets from this host rather than an inherited pwsh 7 path.
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$SourcePatterns = @{
  "tidal" = "tidal"
  "spotify" = "spotify"
  "apple-music" = "apple.*music|music.*apple"
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime]
$script:ArtworkKey = ''
$script:ArtworkData = ''
$script:ArtworkHash = ''
$script:ArtworkAttempt = [DateTime]::MinValue

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

function Get-MediaArtwork {
  param($Media, [string]$Key)
  $capturedAt = [DateTime]::UtcNow
  # Title and thumbnail updates can arrive separately. Recheck a successful
  # thumbnail too, so the previous track's cover cannot remain cached forever.
  if ($Key -eq $script:ArtworkKey -and ($capturedAt - $script:ArtworkAttempt).TotalSeconds -lt 2) { return $script:ArtworkData }
  if ($Key -ne $script:ArtworkKey) {
    $script:ArtworkKey = $Key
    $script:ArtworkData = ''
    $script:ArtworkHash = ''
  }
  $script:ArtworkAttempt = $capturedAt
  $artwork = Read-MediaArtwork $Media
  # Keep a valid cover through a transient thumbnail read failure on this track.
  if ($artwork) { $script:ArtworkData = $artwork }
  return $script:ArtworkData
}

function Read-MediaArtwork {
  param($Media)
  $stream = $null; $memory = $null; $image = $null; $small = $null; $output = $null; $graphics = $null
  try {
    if ($null -eq $Media.Thumbnail) { return '' }
    $stream = Await-WinRt $Media.Thumbnail.OpenReadAsync() ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $method = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStream' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
    $stream = $method.Invoke($null, @($stream))
    if ($stream.Length -lt 1 -or $stream.Length -gt 1048576) { return '' }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $loaded = 0
    while ($loaded -lt $bytes.Length) { $read = $stream.Read($bytes, $loaded, $bytes.Length-$loaded); if ($read -eq 0) { return '' }; $loaded += $read }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = [Convert]::ToBase64String($hasher.ComputeHash($bytes)) } finally { $hasher.Dispose() }
    if ($fingerprint -eq $script:ArtworkHash -and $script:ArtworkData) { return $script:ArtworkData }
    $memory = [System.IO.MemoryStream]::new($bytes, $false)
    $image = [System.Drawing.Image]::FromStream($memory)
    if ($image.Width -gt 8192 -or $image.Height -gt 8192) { return '' }
    $small = [System.Drawing.Bitmap]::new(128, 128)
    $graphics = [System.Drawing.Graphics]::FromImage($small)
    $graphics.Clear([System.Drawing.Color]::Black)
    $scale = [Math]::Min(128.0 / $image.Width, 128.0 / $image.Height)
    $width = [int]($image.Width * $scale); $height = [int]($image.Height * $scale)
    $graphics.DrawImage($image, [int]((128 - $width) / 2), [int]((128 - $height) / 2), $width, $height)
    $output = [System.IO.MemoryStream]::new()
    # Detailed covers can exceed the transport budget even at 128px. Compress
    # progressively instead of silently dropping an otherwise valid thumbnail.
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    foreach ($quality in @(85, 70, 55, 40, 25)) {
      $parameters = [System.Drawing.Imaging.EncoderParameters]::new(1)
      try {
        $parameters.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
        $output.SetLength(0)
        $output.Position = 0
        $small.Save($output, $codec, $parameters)
      } finally { $parameters.Dispose() }
      if ($output.Length -le 9000) { break }
    }
    if ($output.Length -le 9000) {
      $script:ArtworkHash = $fingerprint
      return 'data:image/jpeg;base64,' + [Convert]::ToBase64String($output.ToArray())
    }
    return ''
  } catch { return '' }
  finally { foreach ($resource in @($graphics, $small, $image, $output, $memory, $stream)) { if ($null -ne $resource) { try { $resource.Dispose() } catch {} } } }
}

function Get-MediaSnapshot {
  param($Session)
  if ($null -eq $Session) {
    $script:ArtworkKey = ''
    $script:ArtworkData = ''
    $script:ArtworkHash = ''
    return [ordered]@{ schemaVersion = 2; available = $false; source = $Provider }
  }
  $media = Await-WinRt $Session.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $Session.GetPlaybackInfo()
  $timeline = $Session.GetTimelineProperties()
  $capturedAt = [DateTimeOffset]::UtcNow
  $positionMs = [long]$timeline.Position.TotalMilliseconds
  # Windows exposes a position anchored to LastUpdatedTime, not a continuously ticking clock.
  if ($playback.PlaybackStatus -eq 'Playing' -and $timeline.LastUpdatedTime.Year -gt 2000) {
    $timelineAgeMs = [Math]::Max(0, ($capturedAt - $timeline.LastUpdatedTime).TotalMilliseconds)
    $positionMs += [long]$timelineAgeMs
  }
  if ($timeline.EndTime.TotalMilliseconds -gt 0) { $positionMs = [Math]::Min($positionMs, [long]$timeline.EndTime.TotalMilliseconds) }
  return [ordered]@{
    schemaVersion = 2
    available = $true
    source = $Session.SourceAppUserModelId
    title = [string]$media.Title
    artist = [string]$media.Artist
    album = [string]$media.AlbumTitle
    artworkUrl = Get-MediaArtwork $media (@($Session.SourceAppUserModelId, $media.Title, $media.Artist, $media.AlbumTitle) -join '|')
    status = [string]$playback.PlaybackStatus
    positionMs = $positionMs
    durationMs = [long]$timeline.EndTime.TotalMilliseconds
    observedAt = $capturedAt.ToUnixTimeMilliseconds()
  }
}

$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$snapshot = Get-MediaSnapshot (Find-MediaSession $manager)
$snapshot | ConvertTo-Json -Compress
if ($Once) { exit 0 }

$initialPositionBucket = if ($snapshot.available -and $snapshot.status -eq "Playing") { [long]($snapshot.positionMs / 2000) } else { [long]$snapshot.positionMs }
$lastFingerprint = @($snapshot.available, $snapshot.title, $snapshot.artist, $snapshot.album, $snapshot.status, $initialPositionBucket, $snapshot.durationMs, $snapshot.artworkUrl) -join "|"
while ($true) {
  try {
    $snapshot = Get-MediaSnapshot (Find-MediaSession $manager)
    $positionBucket = if ($snapshot.available -and $snapshot.status -eq "Playing") { [long]($snapshot.positionMs / 2000) } else { [long]$snapshot.positionMs }
    $fingerprint = @($snapshot.available, $snapshot.title, $snapshot.artist, $snapshot.album, $snapshot.status, $positionBucket, $snapshot.durationMs, $snapshot.artworkUrl) -join "|"
    if ($fingerprint -ne $lastFingerprint) {
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
