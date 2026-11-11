$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'extension'
$outputRoot = Join-Path $projectRoot 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$extensionVersion = [string]$manifest.version
if ($extensionVersion -notmatch '^\d+(\.\d+){1,3}$') { throw 'Invalid extension version.' }
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$archive = Join-Path $outputRoot ('wechat-bilibili-v' + $extensionVersion + '.zip')
Compress-Archive -Path (Join-Path $extensionRoot '*') -DestinationPath $archive -Force
Get-Item -LiteralPath $archive | Select-Object FullName, Length
