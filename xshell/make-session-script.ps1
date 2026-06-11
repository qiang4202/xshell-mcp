param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9._-]+$')]
  [string] $SessionId
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $scriptDir 'bridge.js'
$sessionsDir = Join-Path $scriptDir 'sessions'
$targetPath = Join-Path $sessionsDir "$SessionId.js"

New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null

$escapedBridgePath = $bridgePath -replace '\\', '\\'
$content = @"
// Generated Xshell MCP session bridge.
// Run this script inside the Xshell tab/session named: $SessionId

var SESSION_ID = "$SessionId";
eval(new ActiveXObject("Scripting.FileSystemObject").OpenTextFile("$escapedBridgePath", 1, false, -1).ReadAll());
"@

Set-Content -Path $targetPath -Value $content -Encoding Unicode
Write-Output $targetPath
