param([string]$OutputPath = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "desktop\windows-host\RaveLinkCoreHost.cs"
$manifest = Join-Path $root "desktop\windows-host\app.manifest"
$icon = Join-Path $root "assets\RaveLink-Core.ico"
if (!$OutputPath) { $OutputPath = Join-Path $root "RaveLink-Core.exe" }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (!(Test-Path -LiteralPath $compiler)) { throw "Windows C# compiler was not found: $compiler" }
if (!(Test-Path -LiteralPath $icon)) { throw "Windows application icon was not found: $icon" }

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /warnaserror+ "/out:$OutputPath" "/win32manifest:$manifest" "/win32icon:$icon" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) { throw "RaveLink Core Windows host compilation failed with exit code $LASTEXITCODE" }
Write-Host "[WINDOWS HOST] Created $OutputPath"
