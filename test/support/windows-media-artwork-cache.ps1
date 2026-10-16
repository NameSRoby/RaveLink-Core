param([string]$ObserverPath)
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ObserverPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Observer script could not be parsed' }
$cache = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-MediaArtwork' }, $true)
Invoke-Expression $cache.Extent.Text

# Exercise the production cache with a thumbnail that lags behind the title.
$script:ArtworkKey = ''; $script:ArtworkData = ''; $script:ArtworkHash = ''
$script:ArtworkAttempt = [DateTime]::MinValue
$script:Reads = 0; $script:Thumbnail = 'previous-cover'
function Read-MediaArtwork { param($Media) $script:Reads++; return $script:Thumbnail }
function Check($Condition, $Message) { if (!$Condition) { throw $Message } }
Check ((Get-MediaArtwork $null 'previous-song') -eq 'previous-cover') 'Initial cover was not read'
Check ((Get-MediaArtwork $null 'new-song') -eq 'previous-cover') 'Lagging thumbnail setup failed'
Check ($script:Reads -eq 2) 'Track changes must bypass the poll throttle'
$script:Thumbnail = 'new-cover'
Check ((Get-MediaArtwork $null 'new-song') -eq 'previous-cover') 'Unchanged polls should be throttled'
Check ($script:Reads -eq 2) 'Thumbnail reads were not throttled'
$script:ArtworkAttempt = [DateTime]::UtcNow.AddSeconds(-3)
Check ((Get-MediaArtwork $null 'new-song') -eq 'new-cover') 'A delayed cover stayed cached after the title changed'
Check ($script:Reads -eq 3) 'Successful covers must be revalidated'
$script:Thumbnail = ''
$script:ArtworkAttempt = [DateTime]::UtcNow.AddSeconds(-3)
Check ((Get-MediaArtwork $null 'new-song') -eq 'new-cover') 'Transient failure discarded a valid same-track cover'
$script:ArtworkHash = 'old-content-hash'
Check ((Get-MediaArtwork $null 'third-song') -eq '') 'A new track inherited cached artwork after a failed read'
Check ($script:ArtworkHash -eq '') 'A new track inherited the previous source hash'
$script:Thumbnail = 'third-cover'
$script:ArtworkAttempt = [DateTime]::UtcNow.AddSeconds(-3)
Check ((Get-MediaArtwork $null 'third-song') -eq 'third-cover') 'Missing thumbnails must be retried'
Write-Output 'Artwork cache transition checks passed'
