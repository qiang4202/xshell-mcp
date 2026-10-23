param(
  # Fixed session id (non-interactive mode). Optional when -Interactive is used.
  [ValidatePattern('^[a-zA-Z0-9._-]*$')]
  [string] $SessionId,

  # Generate the generic bastion launcher. At run time it asks the operator for
  # the target name (e.g. web-01) and uses it as this tab's stable session id.
  # This is the recommended way to keep every jump-host tab separate.
  [switch] $Interactive,

  # Optional value pre-filled in the interactive input box. Defaults to -SessionId.
  [ValidatePattern('^[a-zA-Z0-9._-]*$')]
  [string] $PromptDefault
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $scriptDir 'bridge.js'
$projectRoot = Split-Path -Parent $scriptDir
$configPath = Join-Path $projectRoot 'xshell-mcp.config.json'
$sessionsDir = Join-Path $scriptDir 'sessions'

# Emit non-ASCII characters as \uXXXX so the generated launcher stays pure
# ASCII. Xshell reads UTF-16 launchers fine, but avoiding non-ASCII source
# removes any doubt about how a given build parses the file.
function ConvertTo-JsUnicodeEscape {
  param([string] $Text)
  $builder = New-Object System.Text.StringBuilder
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    if ($code -gt 127) {
      [void]$builder.Append('\u' + $code.ToString('x4'))
    } else {
      [void]$builder.Append($ch)
    }
  }
  return $builder.ToString()
}

if (-not $Interactive -and [string]::IsNullOrWhiteSpace($SessionId)) {
  throw 'Specify -SessionId <id>, or use -Interactive to generate the bastion launcher.'
}

if ($Interactive -and [string]::IsNullOrWhiteSpace($PromptDefault)) {
  $PromptDefault = $SessionId
}
if ([string]::IsNullOrWhiteSpace($PromptDefault)) {
  $PromptDefault = ''
}

New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null

# Double every backslash so the generated JS string literal interprets them
# literally (the launcher pins absolute Windows paths).
$escapedBridgePath = $bridgePath -replace '\\', '\\'
$escapedConfigPath = $configPath -replace '\\', '\\'
$escapedPromptDefault = $PromptDefault -replace '\\', '\\'

if ($Interactive) {
  # The generic launcher is bastion.js unless an explicit id was supplied.
  $fileName = if ([string]::IsNullOrWhiteSpace($SessionId)) { 'bastion.js' } else { "$SessionId.js" }
  $targetPath = Join-Path $sessionsDir $fileName
  # Chinese prompt text lives here (this file is UTF-16) so bridge.js can stay
  # pure ASCII, which the launcher's ASCII read (format 0) relies on. The
  # strings are emitted as \uXXXX escapes so the launcher itself is ASCII-only.
  $promptMessage = ConvertTo-JsUnicodeEscape '请输入本标签页对应的目标名称，例如 web-01、db-02。\r\n只能包含字母、数字、点、下划线、短横线。'
  $promptTitle = ConvertTo-JsUnicodeEscape 'Xshell MCP - 堡垒机目标'
  $promptInvalid = ConvertTo-JsUnicodeEscape '名称只能包含字母、数字、点、下划线、短横线，请重新输入。'
  $content = @"
// Generated Xshell MCP interactive (bastion) launcher.
// Run this inside EACH bastion/jump-host tab. A dialog asks for the target
// name (e.g. web-01, db-02) and uses it as this tab's stable session id, so
// every tab writes to its own bridge directory instead of all sharing the
// jump host's name.
//
// This launcher pins the absolute bridge + config paths, so bridge.js does not
// have to guess where the project lives.
//
// Format flag MUST stay 0 (ASCII): bridge.js is ASCII/UTF-8 without BOM, and
// reading it as Unicode (-1) yields mojibake that fails with "missing identifier".
//
// Launcher revision: 2026-10-23-b. The prompt and bridge logic live in
// ../bridge.js; this file only pins the absolute paths and sets the flags.

var SESSION_ID_INTERACTIVE = true;
var SESSION_ID_PROMPT_DEFAULT = "$escapedPromptDefault";
var SESSION_ID_PROMPT_MESSAGE = "$promptMessage";
var SESSION_ID_PROMPT_TITLE = "$promptTitle";
var SESSION_ID_PROMPT_INVALID = "$promptInvalid";
var CONFIG_PATH_OVERRIDE = "$escapedConfigPath";
eval(new ActiveXObject("Scripting.FileSystemObject").OpenTextFile("$escapedBridgePath", 1, false, 0).ReadAll());
"@
} else {
  $targetPath = Join-Path $sessionsDir "$SessionId.js"
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
}

Set-Content -Path $targetPath -Value $content -Encoding Unicode
Write-Output $targetPath
