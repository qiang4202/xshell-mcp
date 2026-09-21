param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9._-]+$')]
  [string] $SessionId
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $scriptDir 'bridge.js'
$projectRoot = Split-Path -Parent $scriptDir
$configPath = Join-Path $projectRoot 'xshell-mcp.config.json'
$sessionsDir = Join-Path $scriptDir 'sessions'
$targetPath = Join-Path $sessionsDir "$SessionId.js"

New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null

$escapedBridgePath = $bridgePath -replace '\\', '\\'
$escapedConfigPath = $configPath -replace '\\', '\\'
$content = @"
// Generated Xshell MCP session bridge.
// Run this script inside the Xshell tab/session named: $SessionId
//
// This launcher pins the absolute bridge + config paths, so bridge.js does not
// have to guess where the project lives.
//
// Format flag MUST stay 0 (ASCII): bridge.js is ASCII/UTF-8 without BOM, and
// reading it as Unicode (-1) yields mojibake that fails with "missing identifier".

var SESSION_ID = "$SessionId";
var CONFIG_PATH_OVERRIDE = "$escapedConfigPath";
eval(new ActiveXObject("Scripting.FileSystemObject").OpenTextFile("$escapedBridgePath", 1, false, 0).ReadAll());
"@

Set-Content -Path $targetPath -Value $content -Encoding Unicode
Write-Output $targetPath
