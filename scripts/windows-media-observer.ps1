param(
  [ValidateSet("tidal", "spotify", "apple-music")]
  [string]$Provider = "tidal",
  [switch]$Once
)

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
  if ($Key -eq $script:ArtworkKey -and ($script:ArtworkData -or ((Get-Date) - $script:ArtworkAttempt).TotalSeconds -lt 15)) { return $script:ArtworkData }
  $script:ArtworkKey = $Key
  $script:ArtworkData = ''
  $script:ArtworkAttempt = Get-Date
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
    $small.Save($output, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    if ($output.Length -le 9000) { $script:ArtworkData = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($output.ToArray()) }
    return $script:ArtworkData
  } catch { return '' }
  finally { foreach ($resource in @($graphics, $small, $image, $output, $memory, $stream)) { if ($null -ne $resource) { try { $resource.Dispose() } catch {} } } }
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
    artworkUrl = Get-MediaArtwork $media (@($Session.SourceAppUserModelId, $media.Title, $media.Artist, $media.AlbumTitle) -join '|')
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
$lastFingerprint = @($snapshot.available, $snapshot.title, $snapshot.artist, $snapshot.album, $snapshot.status, $initialPositionBucket, $snapshot.durationMs, $snapshot.artworkUrl) -join "|"
while ($true) {
  try {
    $snapshot = Get-MediaSnapshot (Find-MediaSession $manager)
    $positionBucket = if ($snapshot.available -and $snapshot.status -eq "Playing") { [long]($snapshot.positionMs / 2000) } else { [long]$snapshot.positionMs }
    $fingerprint = @($snapshot.available, $snapshot.title, $snapshot.artist, $snapshot.album, $snapshot.status, $positionBucket, $snapshot.durationMs, $snapshot.artworkUrl) -join "|"
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
