// Xshell MCP bridge script.
// Plain old JScript version for Xshell script host.

var POLL_MS = 50;
var HEARTBEAT_MS = 2000;
var WAITFOR_INITIAL_SLEEP_MS = 50;
var WAITFOR_POLL_MS = 200;
var DEFAULT_READ_ROWS = 120;
var DEFAULT_READ_COLUMNS = 240;
var SHOW_STARTUP_MESSAGE = true;
var BRIDGE_VERSION = "plain-js-20261023-4";
var BACKSLASH = String.fromCharCode(92);
var DQ = String.fromCharCode(34);
var CTRL_C = String.fromCharCode(3);
var CONFIG_FILE_NAME = "xshell-mcp.config.json";
// How long a status.json stays "live" when deciding whether another bridge
// already owns a session directory (see isBridgeDirLive).
var COLLISION_FRESH_MS = 10000;
var COLLISION_MAX_SUFFIX = 99;

var fso = new ActiveXObject("Scripting.FileSystemObject");
var lastHeartbeatAt = 0;
var totalHandled = 0;
var totalFailed = 0;
var totalRecovered = 0;
var QUIT_REQUESTED = false;
var CONFIG_DIAGNOSTICS = [];
// Set by promptForSessionId() when no real answer was obtained. The caller then
// treats the id as auto-detected (and applies the collision guard) instead of
// mislabelling it as an operator-provided name.
var SESSION_ID_PROMPT_FELL_BACK = false;

function diag(message) {
  try {
    if (CONFIG_DIAGNOSTICS.length < 40) {
      CONFIG_DIAGNOSTICS.push(String(message));
    }
  } catch (e) {
  }
}

// Append prompt diagnostics to a fixed file so a failed input dialog can be
// investigated without relying on a screenshot of the startup message box.
function promptDiag(message) {
  try {
    var path = BRIDGE_ROOT_DIR + BACKSLASH + "prompt-diag.log";
    var file = fso.OpenTextFile(path, 8, true, -1);
    file.Write("[" + nowIsoLike() + "] " + message + "\r\n");
    file.Close();
  } catch (e) {
  }
}

// WScript.Shell.Environment takes a SCOPE ("Process"/"User"/"System"), not a variable name.
function envGet(name) {
  var scopes = ["Process", "User", "System"];
  for (var i = 0; i < scopes.length; i = i + 1) {
    try {
      var sh = new ActiveXObject("WScript.Shell");
      var value = sh.Environment(scopes[i]).Item(name);
      if (value !== null && typeof value != "undefined" && String(value).length > 0) {
        return String(value);
      }
    } catch (e) {
    }
  }
  return "";
}

var HOSTNAME = (function () {
  var name = envGet("COMPUTERNAME");
  return name ? name : "unknown";
})();

var BRIDGE_SCRIPT_PATH = (function () {
  try {
    if (typeof xsh != "undefined" && xsh.Session && xsh.Session.ScriptPath) {
      var sp = String(xsh.Session.ScriptPath);
      if (sp.length > 0) {
        return sp;
      }
    }
  } catch (e1) {
  }
  var fromEnv = envGet("XSHELL_MCP_BRIDGE_SCRIPT");
  if (fromEnv) {
    return fromEnv;
  }
  return "";
})();

var CONFIG_PATH = (function () {
  if (typeof CONFIG_PATH_OVERRIDE != "undefined" && CONFIG_PATH_OVERRIDE) {
    diag("config: CONFIG_PATH_OVERRIDE");
    return String(CONFIG_PATH_OVERRIDE);
  }
  var fromEnv = envGet("XSHELL_MCP_CONFIG");
  if (fromEnv) {
    diag("config: env XSHELL_MCP_CONFIG");
    return fromEnv;
  }
  if (BRIDGE_SCRIPT_PATH) {
    var derived = resolveConfigPathFromScriptPath(BRIDGE_SCRIPT_PATH);
    if (derived && fso.FileExists(derived)) {
      diag("config: derived from script path");
      return derived;
    }
  }
  var candidates = candidateConfigPaths();
  for (var i = 0; i < candidates.length; i = i + 1) {
    try {
      if (fso.FileExists(candidates[i])) {
        diag("config: found at " + candidates[i]);
        return candidates[i];
      }
    } catch (eCand) {
    }
  }
  diag("config: NOT FOUND (checked " + candidates.length + " paths)");
  return "";
})();

function userHomeDir() {
  var home = envGet("USERPROFILE");
  if (home) {
    return normalizeDir(home);
  }
  var drive = envGet("HOMEDRIVE");
  var rest = envGet("HOMEPATH");
  if (drive && rest) {
    return normalizeDir(String(drive) + String(rest));
  }
  // FSO is always available inside Xshell; derive the profile from %TEMP%
  // (<profile>\AppData\Local\Temp) when WScript.Shell is unavailable.
  try {
    var temp = String(fso.GetSpecialFolder(2));
    var profile = parentDir(parentDir(parentDir(temp)));
    if (profile) {
      return profile;
    }
  } catch (eTmp) {
    diag("home: GetSpecialFolder failed: " + (eTmp.message || String(eTmp)));
  }
  return "";
}

function candidateConfigPaths() {
  var out = [];
  var home = userHomeDir();
  if (home) {
    out.push(home + BACKSLASH + CONFIG_FILE_NAME);
    out.push(home + BACKSLASH + "Documents" + BACKSLASH + "xshell-mcp" + BACKSLASH + CONFIG_FILE_NAME);
  }
  var subDirs = [
    "mcp" + BACKSLASH + "xshell-mcp",
    "my-xshell-mcp",
    "xshell-mcp",
    "code" + BACKSLASH + "xshell-mcp"
  ];
  // Probe drive letters directly: FSO.DriveExists is core, unlike WSH's Enumerator.
  var letters = "CDEFGABHIJKLMNOPQRSTUVWXYZ";
  for (var li = 0; li < letters.length; li = li + 1) {
    var driveRoot = letters.charAt(li) + ":";
    try {
      if (!fso.DriveExists(driveRoot)) {
        continue;
      }
    } catch (eDrive) {
      continue;
    }
    for (var i = 0; i < subDirs.length; i = i + 1) {
      out.push(driveRoot + BACKSLASH + subDirs[i] + BACKSLASH + CONFIG_FILE_NAME);
    }
  }
  diag("scan: probing " + out.length + " candidate paths");
  return out;
}

function resolveBridgeRootDir() {
  if (typeof BRIDGE_ROOT_DIR_OVERRIDE != "undefined" && BRIDGE_ROOT_DIR_OVERRIDE) {
    diag("bridgeRoot: BRIDGE_ROOT_DIR_OVERRIDE");
    return String(BRIDGE_ROOT_DIR_OVERRIDE);
  }
  try {
    var cp = CONFIG_PATH;
    if (cp && fso.FileExists(cp)) {
      var cfg = parseJson(readFile(cp));
      if (cfg && cfg.bridgeRootDir) {
        var root = String(cfg.bridgeRootDir);
        if (root.length > 0) {
          diag("bridgeRoot: from config -> " + root);
          return root;
        }
      }
    }
  } catch (eCfg) {
    diag("bridgeRoot: config read failed: " + (eCfg.message || String(eCfg)));
  }
  var home = userHomeDir();
  if (home) {
    diag("bridgeRoot: fallback to user home (config not found)");
    return home + BACKSLASH + "Documents" + BACKSLASH + "xshell-mcp-bridge";
  }
  diag("bridgeRoot: fallback to temp folder (config not found)");
  try {
    var temp = String(fso.GetSpecialFolder(2));
    if (temp) {
      return temp + BACKSLASH + "xshell-mcp-bridge";
    }
  } catch (eTmp2) {
  }
  var systemDrive = envGet("SystemDrive");
  if (systemDrive) {
    return String(systemDrive) + BACKSLASH + "xshell-mcp-bridge";
  }
  return "C:" + BACKSLASH + "xshell-mcp-bridge";
}

function normalizeDir(path) {
  var p = String(path);
  while (p.length > 0 && (p.charAt(p.length - 1) == BACKSLASH || p.charAt(p.length - 1) == "/")) {
    p = p.substring(0, p.length - 1);
  }
  return p;
}

function parentDir(path) {
  var p = normalizeDir(path);
  var idx = -1;
  for (var i = p.length - 1; i >= 0; i = i - 1) {
    var c = p.charAt(i);
    if (c == BACKSLASH || c == "/") {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    return "";
  }
  return p.substring(0, idx);
}

function resolveConfigPathFromScriptPath(scriptPath) {
  var p = normalizeDir(scriptPath);
  if (!p) {
    return "";
  }
  var xshellDir = parentDir(p);
  if (!xshellDir) {
    return "";
  }
  var projectRoot = parentDir(xshellDir);
  if (!projectRoot) {
    return xshellDir + BACKSLASH + "xshell-mcp.config.json";
  }
  return projectRoot + BACKSLASH + "xshell-mcp.config.json";
}

function logLine(message) {
  try {
    var line = "[" + nowIsoLike() + "] " + message + "\r\n";
    var sh = new ActiveXObject("WScript.Shell");
    sh.LogEvent(1, "xshell-mcp-bridge: " + message);
  } catch (e) {
  }
}

function isSpaceChar(ch) {
  return ch == " " || ch == "\t" || ch == "\r" || ch == "\n";
}

function trimText(value) {
  var text = String(value);
  var ch = "";
  while (text.length > 0) {
    ch = text.charAt(0);
    if (isSpaceChar(ch)) {
      text = text.substring(1);
    } else {
      break;
    }
  }
  while (text.length > 0) {
    ch = text.charAt(text.length - 1);
    if (isSpaceChar(ch)) {
      text = text.substring(0, text.length - 1);
    } else {
      break;
    }
  }
  return text;
}

function isAllowedIdChar(ch) {
  var code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    return true;
  }
  if (code >= 65 && code <= 90) {
    return true;
  }
  if (code >= 97 && code <= 122) {
    return true;
  }
  return ch == "." || ch == "_" || ch == "-";
}

function sanitizeId(value) {
  var source = trimText(value);
  var out = "";
  var i = 0;
  var ch = "";
  var lastDash = false;
  for (i = 0; i < source.length; i = i + 1) {
    ch = source.charAt(i);
    if (isAllowedIdChar(ch)) {
      out += ch;
      lastDash = false;
    } else {
      if (!lastDash) {
        out += "-";
        lastDash = true;
      }
    }
  }
  while (out.length > 0 && out.charAt(0) == "-") {
    out = out.substring(1);
  }
  while (out.length > 0 && out.charAt(out.length - 1) == "-") {
    out = out.substring(0, out.length - 1);
  }
  if (!out) {
    out = "default";
  }
  return out;
}

function safeSessionValue(name) {
  try {
    var value = xsh.Session[name];
    if (value) {
      return String(value);
    }
  } catch (e) {
  }
  return "";
}

function detectSessionId() {
  var detected = safeSessionValue("SessionName");
  var remotePort = "";
  if (!detected) {
    detected = safeSessionValue("TabText");
  }
  if (!detected) {
    detected = safeSessionValue("RemoteAddress");
    remotePort = safeSessionValue("RemotePort");
    if (detected && remotePort) {
      detected = detected + "-" + remotePort;
    }
  }
  if (!detected) {
    detected = "default";
  }
  return sanitizeId(detected);
}

// Read a file written with FSO format -1 (Unicode/UTF-16), such as status.json.
// Using format 0 here would mis-decode it and make the ownership check useless.
function readUnicodeFile(filePath) {
  var file = fso.OpenTextFile(filePath, 1, false, -1);
  var text = file.ReadAll();
  file.Close();
  return text;
}

// True when another bridge currently owns this directory. File mtime is used for
// freshness instead of parsing the ISO timestamp, because older JScript engines
// do not parse "2026-10-23T12:00:00Z" reliably. A bridge that asked to quit
// (quitRequested=true) releases the directory immediately, so a quick restart
// after xshell_bridge_stop reuses the same id instead of growing a new suffix.
function isBridgeDirLive(dirPath) {
  var statusPath = dirPath + BACKSLASH + "status.json";
  try {
    if (!fso.FileExists(statusPath)) {
      return false;
    }
    var status = null;
    try {
      status = parseJson(readUnicodeFile(statusPath));
    } catch (eStatus) {
      status = null;
    }
    if (status && status.quitRequested === true) {
      return false;
    }
    // DateLastModified is a Date in real FSO, but wrapping it also tolerates
    // hosts that hand back a date string.
    var modifiedMs = new Date(fso.GetFile(statusPath).DateLastModified).getTime();
    if (!isFinite(modifiedMs)) {
      return false;
    }
    var age = new Date().getTime() - modifiedMs;
    return age <= COLLISION_FRESH_MS;
  } catch (eLive) {
    return false;
  }
}

// Pick a free session id by appending -2, -3, ... when the auto-detected name is
// already served by a live bridge. This is the safety net for operators who run
// plain bridge.js in several bastion tabs; explicit/prompted ids skip this.
function disambiguateSessionId(baseId) {
  if (!isBridgeDirLive(BRIDGE_ROOT_DIR + BACKSLASH + baseId)) {
    return baseId;
  }
  var n = 2;
  var candidate = baseId;
  while (n <= COLLISION_MAX_SUFFIX) {
    candidate = baseId + "-" + String(n);
    if (!isBridgeDirLive(BRIDGE_ROOT_DIR + BACKSLASH + candidate)) {
      return candidate;
    }
    n = n + 1;
  }
  // Extremely unlikely: a time suffix guarantees we never share a directory.
  return baseId + "-" + String(new Date().getTime());
}

// Escape a string for a VBScript literal and collapse newlines: InputBox shows
// a single-line prompt more predictably than an embedded CRLF.
function vbEscape(text) {
  var s = String(text);
  s = s.replace(/\r\n/g, " ").replace(/[\r\n]/g, " ");
  return s.replace(/"/g, '""');
}

// Native Windows input box through VBScript's InputBox. This bypasses Xshell's
// late-bound Dialog.Prompt, which some 7.x builds reject with 449/450 no matter
// how many arguments are passed.
function promptWithScriptControl(message, title, fallback) {
  try {
    var control = new ActiveXObject("MSScriptControl.ScriptControl");
    control.Language = "VBScript";
    var expression = 'InputBox("' + vbEscape(message) + '", "' +
      vbEscape(title) + '", "' + vbEscape(fallback) + '")';
    var value = control.Eval(expression);
    if (value === null || typeof value == "undefined") {
      return { ok: true, value: "" };
    }
    return { ok: true, value: String(value) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Last-resort input box: write a tiny VBS launcher and run it with cscript.
// It is independent of both xsh.Dialog and MSScriptControl.
function promptWithVbsScript(message, title, fallback) {
  var tempDir = "";
  try {
    tempDir = String(fso.GetSpecialFolder(2));
  } catch (eTemp) {
    tempDir = BRIDGE_ROOT_DIR;
  }
  var stamp = String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 1000000));
  var vbsPath = tempDir + BACKSLASH + "xshell-mcp-prompt-" + stamp + ".vbs";
  var resultPath = tempDir + BACKSLASH + "xshell-mcp-prompt-" + stamp + ".txt";
  promptDiag("VBS path=" + vbsPath);
  try {
    var vbs =
      "Dim v\r\n" +
      "v = InputBox(\"" + vbEscape(message) + "\", \"" + vbEscape(title) + "\", \"" + vbEscape(fallback) + "\")\r\n" +
      "Dim fso\r\n" +
      "Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n" +
      "Dim f\r\n" +
      "Set f = fso.CreateTextFile(\"" + resultPath.replace(/"/g, '""') + "\", True, True)\r\n" +
      "f.Write v\r\n" +
      "f.Close\r\n";
    var outFile = fso.OpenTextFile(vbsPath, 8, true, -1);
    outFile.Write(vbs);
    outFile.Close();
    promptDiag("VBS written");

    var shell = new ActiveXObject("WScript.Shell");
    var rc = shell.Run("cscript //Nologo \"" + vbsPath + "\"", 0, true);
    promptDiag("VBS cscript rc=" + rc);

    var value = "";
    try {
      var inFile = fso.OpenTextFile(resultPath, 1, false, -1);
      value = inFile.ReadAll();
      inFile.Close();
    } catch (eRead) {
      value = "";
    }
    promptDiag("VBS resultExists=" + fso.FileExists(resultPath) + " value=[" + value + "]");
    safeDeleteFile(vbsPath);
    safeDeleteFile(resultPath);
    return { ok: true, value: String(value).replace(/^\uFEFF/, "") };
  } catch (e) {
    promptDiag("VBS exception: " + (e.message || String(e)));
    safeDeleteFile(vbsPath);
    safeDeleteFile(resultPath);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Xshell builds differ in how strictly they enforce Prompt's optional
// parameters; some report "argument not optional" for one form. Try the
// documented 4-arg form first (numeric hidden flag, as in the official
// examples), then progressively simpler forms. Errors before the dialog is
// shown are safe to retry; every failure is recorded for diagnostics.
function callPromptDialog(message, title, fallback) {
  var lastError = "";
  var attempts = [
    function () { return xsh.Dialog.Prompt(message, title, fallback, 0); },
    function () { return xsh.Dialog.Prompt(message, title, fallback, false); },
    function () { return xsh.Dialog.Prompt(message, title, fallback); },
    function () { return xsh.Dialog.Prompt(message, title); },
    function () { return xsh.Dialog.Prompt(message); },
    // Some builds expose a fifth (timeout) parameter and report 449 without it.
    function () { return xsh.Dialog.Prompt(message, title, fallback, 0, 30000); },
    function () { return xsh.Dialog.Prompt(message, title, fallback, false, 30000); },
    function () { return xsh.Dialog.Prompt(message, title, fallback, 0, 0); },
    function () { return xsh.Dialog.Prompt(message, title, fallback, 0, 30000, 0); },
    // Last resort: some builds renamed the input method.
    function () { return xsh.Dialog.InputBox(message, title, fallback); },
    function () { return xsh.Dialog.InputBox(message, title, fallback, 0); }
  ];
  for (var i = 0; i < attempts.length; i = i + 1) {
    try {
      return { ok: true, value: attempts[i]() };
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      diag("prompt attempt " + (i + 1) + " failed: " + lastError);
      promptDiag("xsh attempt " + (i + 1) + " failed: " + lastError);
    }
  }

  // Xshell's own Prompt binding is unusable on some 7.x builds. Fall back to a
  // native Windows input box, first via ScriptControl, then via cscript+VBS.
  promptDiag("ScriptControl: trying");
  var scriptControlResult = promptWithScriptControl(message, title, fallback);
  if (scriptControlResult.ok) {
    promptDiag("ScriptControl: ok value=" + scriptControlResult.value);
    return scriptControlResult;
  }
  diag("prompt: ScriptControl fallback failed: " + scriptControlResult.error);
  promptDiag("ScriptControl: failed: " + scriptControlResult.error);

  promptDiag("VBS: trying");
  var vbsResult = promptWithVbsScript(message, title, fallback);
  if (vbsResult.ok) {
    promptDiag("VBS: ok value=" + vbsResult.value);
    return vbsResult;
  }
  diag("prompt: cscript fallback failed: " + vbsResult.error);
  promptDiag("VBS: failed: " + vbsResult.error);

  return {
    ok: false,
    error: lastError + " | " + scriptControlResult.error + " | " + vbsResult.error
  };
}

// Ask the operator which target this tab points at. Used by the interactive
// (bastion) launcher. Falls back to auto-detection when cancelled or when the
// dialog is unavailable, so the bridge still starts.
//
// The messages default to English because bridge.js must stay ASCII (the
// launcher reads it with FSO format 0). A UTF-16 launcher can override them
// through SESSION_ID_PROMPT_MESSAGE / _TITLE / _INVALID.
function promptForSessionId() {
  promptDiag("prompt start");
  var fallback = "";
  if (typeof SESSION_ID_PROMPT_DEFAULT != "undefined" && SESSION_ID_PROMPT_DEFAULT) {
    fallback = String(SESSION_ID_PROMPT_DEFAULT);
  }
  var message = "Enter this tab's target name (e.g. web-01, db-02).\r\n" +
    "Allowed: letters, digits, dot, underscore, hyphen.";
  if (typeof SESSION_ID_PROMPT_MESSAGE != "undefined" && SESSION_ID_PROMPT_MESSAGE) {
    message = String(SESSION_ID_PROMPT_MESSAGE);
  }
  var title = "Xshell MCP - target name";
  if (typeof SESSION_ID_PROMPT_TITLE != "undefined" && SESSION_ID_PROMPT_TITLE) {
    title = String(SESSION_ID_PROMPT_TITLE);
  }
  var invalidMessage = "Name may only contain letters, digits, dot, underscore and hyphen. Try again.";
  if (typeof SESSION_ID_PROMPT_INVALID != "undefined" && SESSION_ID_PROMPT_INVALID) {
    invalidMessage = String(SESSION_ID_PROMPT_INVALID);
  }

  var attempt = 0;
  while (attempt < 3) {
    attempt = attempt + 1;
    var answer = "";
    var promptResult = callPromptDialog(message, title, fallback);
    if (!promptResult.ok) {
      diag("prompt: all forms failed: " + promptResult.error);
      break;
    }
    if (promptResult.value !== null && typeof promptResult.value != "undefined") {
      answer = trimText(String(promptResult.value));
    }
    if (!answer) {
      break;
    }
    var cleaned = sanitizeId(answer);
    // sanitizeId() returns "default" both for the literal name and for input
    // made entirely of invalid characters; only the former is acceptable.
    if (cleaned != "default" || answer == "default") {
      promptDiag("prompt accepted id=" + cleaned);
      return cleaned;
    }
    try {
      xsh.Dialog.MsgBox(invalidMessage);
    } catch (eMsg) {
    }
  }
  diag("prompt: falling back to auto-detected session id");
  promptDiag("prompt falling back to auto");
  SESSION_ID_PROMPT_FELL_BACK = true;
  SESSION_ID_DETECTED = detectSessionId();
  return SESSION_ID_DETECTED;
}

// --- Session id resolution ------------------------------------------------
// Under a bastion/jump host every tab reports the same SessionName and
// RemoteAddress, so auto-detection would collapse all tabs onto one bridge
// directory (one MCP session, racing requests). Resolution order:
//   1. an explicit SESSION_ID injected by a fixed launcher;
//   2. an operator-typed name from the interactive launcher;
//   3. auto-detection, disambiguated with -2/-3 if that directory is live.
var SESSION_ID;
var SESSION_ID_SOURCE = (typeof SESSION_ID != "undefined" && SESSION_ID) ? "explicit" : "auto";
var SESSION_ID_DETECTED = "";
var SESSION_ID_COLLISION = false;

var BRIDGE_ROOT_DIR = resolveBridgeRootDir();

if (!SESSION_ID) {
  if (typeof SESSION_ID_INTERACTIVE != "undefined" && SESSION_ID_INTERACTIVE) {
    try {
      SESSION_ID = promptForSessionId();
      // A cancelled dialog (or unavailable Prompt) falls back to auto-detection;
      // keep the source honest so agents know the name is not operator-provided.
      SESSION_ID_SOURCE = SESSION_ID_PROMPT_FELL_BACK ? "auto" : "prompt";
    } catch (ePromptResolve) {
      // Never let a broken dialog binding kill the whole bridge.
      diag("prompt: unexpected error: " + (ePromptResolve.message || String(ePromptResolve)));
      promptDiag("prompt unexpected error: " + (ePromptResolve.message || String(ePromptResolve)));
      SESSION_ID_PROMPT_FELL_BACK = true;
      SESSION_ID_DETECTED = detectSessionId();
      SESSION_ID = SESSION_ID_DETECTED;
      SESSION_ID_SOURCE = "auto";
    }
  } else {
    SESSION_ID_DETECTED = detectSessionId();
    SESSION_ID = SESSION_ID_DETECTED;
    SESSION_ID_SOURCE = "auto";
  }
}

if (SESSION_ID_SOURCE == "auto") {
  var collisionFreeId = disambiguateSessionId(SESSION_ID);
  if (collisionFreeId != SESSION_ID) {
    SESSION_ID = collisionFreeId;
    SESSION_ID_SOURCE = "auto-disambiguated";
    SESSION_ID_COLLISION = true;
    diag("session: auto-detected '" + SESSION_ID_DETECTED + "' was live, using '" + SESSION_ID + "'");
  }
}

var BRIDGE_DIR = BRIDGE_ROOT_DIR + BACKSLASH + SESSION_ID;
var STARTED_AT = nowIsoLike();

function ensureDir(dirPath) {
  if (!fso.FolderExists(dirPath)) {
    fso.CreateFolder(dirPath);
  }
}

function ensureBridgeDirs() {
  ensureDir(BRIDGE_ROOT_DIR);
  ensureDir(BRIDGE_DIR);
  ensureDir(BRIDGE_DIR + BACKSLASH + "requests");
  ensureDir(BRIDGE_DIR + BACKSLASH + "responses");
  ensureDir(BRIDGE_DIR + BACKSLASH + "logs");
}

function readFile(filePath) {
  var file = fso.OpenTextFile(filePath, 1, false, 0);
  var text = file.ReadAll();
  file.Close();
  return text;
}

var writeCounter = 0;

function randSuffix() {
  writeCounter = writeCounter + 1;
  return String(writeCounter) + "." + String(new Date().getTime()) + "." + String(Math.floor(Math.random() * 0x7fffffff));
}

function safeDeleteFile(filePath) {
  try {
    if (fso.FileExists(filePath)) {
      fso.DeleteFile(filePath, true);
    }
  } catch (e) {
  }
}

function writeFile(filePath, text) {
  var tempPath = filePath + "." + randSuffix() + ".tmp";
  safeDeleteFile(tempPath);
  try {
    var file = fso.OpenTextFile(tempPath, 8, true, -1);
    file.Write(text);
    file.Close();
  } catch (eWrite) {
    throw "writeFile failed at temp " + tempPath + ": " + (eWrite.message || String(eWrite));
  }
  if (fso.FileExists(filePath)) {
    safeDeleteFile(filePath);
  }
  try {
    fso.MoveFile(tempPath, filePath);
  } catch (eMove) {
    safeDeleteFile(tempPath);
    throw "writeFile MoveFile failed from " + tempPath + " to " + filePath + ": " + (eMove.message || String(eMove));
  }
}

function jsonEscape(value) {
  var text = String(value);
  var out = "";
  var i = 0;
  var ch = "";
  var code = 0;
  for (i = 0; i < text.length; i = i + 1) {
    ch = text.charAt(i);
    code = text.charCodeAt(i);
    if (ch == "\\") {
      out += "\\\\";
    } else if (ch == "\"") {
      out += "\\\"";
    } else if (ch == "\r") {
      out += "\\r";
    } else if (ch == "\n") {
      out += "\\n";
    } else if (ch == "\t") {
      out += "\\t";
    } else if (code < 32) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

function writeResponse(id, ok, result, error) {
  var json = "{";
  json += DQ + "id" + DQ + ":" + DQ + jsonEscape(id) + DQ + ",";
  if (ok) {
    json += DQ + "ok" + DQ + ":true";
  } else {
    json += DQ + "ok" + DQ + ":false";
  }
  if (typeof result != "undefined") {
    json += "," + DQ + "result" + DQ + ":" + DQ + jsonEscape(result) + DQ;
  }
  if (error) {
    json += "," + DQ + "error" + DQ + ":" + DQ + jsonEscape(error) + DQ;
  }
  json += "}";
  writeFile(BRIDGE_DIR + BACKSLASH + "responses" + BACKSLASH + id + ".json", json);
}

function writeStructuredResponse(id, ok, payload, errorText) {
  var json = "{";
  json += DQ + "id" + DQ + ":" + DQ + jsonEscape(id) + DQ + ",";
  json += DQ + "ok" + DQ + ":" + (ok ? "true" : "false") + ",";
  json += DQ + "result" + DQ + ":";
  json += serializeStructured(payload);
  // The server reads a top-level "error"; without this the reason for a failed
  // request is lost and surfaces as "unknown error".
  if (errorText) {
    json += "," + DQ + "error" + DQ + ":" + DQ + jsonEscape(errorText) + DQ;
  }
  json += "}";
  writeFile(BRIDGE_DIR + BACKSLASH + "responses" + BACKSLASH + id + ".json", json);
}

function serializeStructured(value) {
  if (value === null || typeof value == "undefined") {
    return "null";
  }
  if (typeof value == "string") {
    return DQ + jsonEscape(value) + DQ;
  }
  if (typeof value == "number") {
    return isFinite(value) ? String(value) : "null";
  }
  if (typeof value == "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value == "object" && typeof value.length == "number") {
    var out = "[";
    for (var i = 0; i < value.length; i = i + 1) {
      if (i > 0) out += ",";
      out += serializeStructured(value[i]);
    }
    out += "]";
    return out;
  }
  if (typeof value == "object") {
    var parts = [];
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      parts.push(DQ + jsonEscape(key) + DQ + ":" + serializeStructured(value[key]));
    }
    return "{" + parts.join(",") + "}";
  }
  return DQ + jsonEscape(String(value)) + DQ;
}

function pad2(value) {
  if (value < 10) {
    return "0" + value;
  }
  return String(value);
}

function nowIsoLike() {
  var date = new Date();
  var text = "";
  text += date.getUTCFullYear();
  text += "-";
  text += pad2(date.getUTCMonth() + 1);
  text += "-";
  text += pad2(date.getUTCDate());
  text += "T";
  text += pad2(date.getUTCHours());
  text += ":";
  text += pad2(date.getUTCMinutes());
  text += ":";
  text += pad2(date.getUTCSeconds());
  text += "Z";
  return text;
}

function writeStatus() {
  var json = "{";
  json += DQ + "ok" + DQ + ":true,";
  json += DQ + "version" + DQ + ":" + DQ + jsonEscape(BRIDGE_VERSION) + DQ + ",";
  json += DQ + "sessionId" + DQ + ":" + DQ + jsonEscape(SESSION_ID) + DQ + ",";
  // How the id was chosen, so agents can tell a meaningful operator-typed name
  // (explicit/prompt) from a jump-host name shared by every bastion tab (auto).
  json += DQ + "sessionSource" + DQ + ":" + DQ + jsonEscape(SESSION_ID_SOURCE) + DQ + ",";
  json += DQ + "detectedSessionId" + DQ + ":" + DQ + jsonEscape(SESSION_ID_DETECTED) + DQ + ",";
  json += DQ + "alias" + DQ + ":" + DQ + jsonEscape(SESSION_ID) + DQ + ",";
  json += DQ + "collisionDisambiguated" + DQ + ":" + (SESSION_ID_COLLISION ? "true" : "false") + ",";
  json += DQ + "startedAt" + DQ + ":" + DQ + jsonEscape(STARTED_AT) + DQ + ",";
  json += DQ + "lastSeenAt" + DQ + ":" + DQ + jsonEscape(nowIsoLike()) + DQ + ",";
  json += DQ + "bridgeDir" + DQ + ":" + DQ + jsonEscape(BRIDGE_DIR) + DQ + ",";
  json += DQ + "bridgeRootDir" + DQ + ":" + DQ + jsonEscape(BRIDGE_ROOT_DIR) + DQ + ",";
  json += DQ + "bridgeScriptPath" + DQ + ":" + DQ + jsonEscape(BRIDGE_SCRIPT_PATH) + DQ + ",";
  json += DQ + "hostname" + DQ + ":" + DQ + jsonEscape(HOSTNAME) + DQ + ",";
  // Under a bastion these point at the jump host, which is why the session id
  // (not the remote address) is what distinguishes individual targets.
  json += DQ + "remoteAddress" + DQ + ":" + DQ + jsonEscape(safeSessionValue("RemoteAddress")) + DQ + ",";
  json += DQ + "remotePort" + DQ + ":" + DQ + jsonEscape(safeSessionValue("RemotePort")) + DQ + ",";
  json += DQ + "pollMs" + DQ + ":" + String(POLL_MS) + ",";
  json += DQ + "totalHandled" + DQ + ":" + String(totalHandled) + ",";
  json += DQ + "totalFailed" + DQ + ":" + String(totalFailed) + ",";
  json += DQ + "totalRecovered" + DQ + ":" + String(totalRecovered) + ",";
  json += DQ + "quitRequested" + DQ + ":" + (QUIT_REQUESTED ? "true" : "false");
  json += "}";
  writeFile(BRIDGE_DIR + BACKSLASH + "status.json", json);
}

function appendBridgeLog(level, message) {
  try {
    var line =
      "{" +
      DQ + "ts" + DQ + ":" + DQ + jsonEscape(nowIsoLike()) + DQ + "," +
      DQ + "level" + DQ + ":" + DQ + jsonEscape(level) + DQ + "," +
      DQ + "sessionId" + DQ + ":" + DQ + jsonEscape(SESSION_ID) + DQ + "," +
      DQ + "message" + DQ + ":" + DQ + jsonEscape(message) +
      "}\r\n";
    var path = BRIDGE_DIR + BACKSLASH + "logs" + BACKSLASH + "bridge.log";
    var ts = fso.OpenTextFile(path, 8, true, -1);
    ts.Write(line);
    ts.Close();
  } catch (e) {
  }
}

function removeBom(text) {
  text = String(text);
  if (text.length > 0 && text.charCodeAt(0) == 65279) {
    text = text.substring(1);
  }
  return text;
}

function parseJson(text) {
  text = removeBom(text);
  return eval("(" + text + ")");
}

function sleep(ms) {
  xsh.Session.Sleep(ms);
}

function readScreen(rows, columns) {
  var maxRows = rows || DEFAULT_READ_ROWS;
  var maxColumns = columns || DEFAULT_READ_COLUMNS;
  var output = "";
  var row = 1;
  var currentRow = maxRows;
  var startRow = 1;
  try {
    currentRow = xsh.Screen.CurrentRow;
  } catch (e) {
    currentRow = maxRows;
  }
  if (!currentRow || currentRow < 1) {
    currentRow = maxRows;
  }
  startRow = currentRow - maxRows + 1;
  if (startRow < 1) {
    startRow = 1;
  }
  for (row = startRow; row <= currentRow; row = row + 1) {
    try {
      output += xsh.Screen.Get(row, 1, row, maxColumns) + "\r\n";
    } catch (e2) {
      break;
    }
  }
  return output;
}

function waitForText(text, timeoutMs) {
  var deadline = new Date().getTime() + (timeoutMs || 30000);
  sleep(WAITFOR_INITIAL_SLEEP_MS);
  while (new Date().getTime() < deadline) {
    var content = readScreen(120, 240);
    if (content.indexOf(text) >= 0) {
      return true;
    }
    sleep(WAITFOR_POLL_MS);
  }
  return false;
}

function markerForShellType(shellType, marker) {
  switch (shellType) {
    case "posix":
      return "echo '" + String(marker).replace(/'/g, "'\\''") + "'";
    case "cmd":
      return "echo " + marker;
    case "powershell":
      return "Write-Output '" + String(marker).replace(/'/g, "''") + "'";
    default:
      return "";
  }
}

function makeItemMarker() {
  writeCounter = writeCounter + 1;
  return "__XSHELL_MCP_DONE_" + String(new Date().getTime()) + "_" + String(writeCounter) + "__";
}

// Send Ctrl+C (twice: once to leave an interactive program, once to clear the
// line) followed by a newline, to pull a stuck shell back to its prompt.
function interruptShell(times) {
  var count = times || 2;
  var i = 0;
  for (i = 0; i < count; i = i + 1) {
    try {
      xsh.Screen.Send(CTRL_C);
    } catch (eInt) {
      appendBridgeLog("error", "interrupt send failed: " + (eInt.message || String(eInt)));
    }
    try {
      sleep(150);
    } catch (eIntSleep) {
    }
  }
  try {
    xsh.Screen.Send("\r");
  } catch (eIntCr) {
  }
  totalRecovered = totalRecovered + 1;
  appendBridgeLog("warn", "sent Ctrl+C x" + count + " to reclaim the shell prompt");
}

function executeOneItem(item, defaultTimeoutMs, defaultShellType) {
  var shellType = item.shellType || defaultShellType || "raw";
  var timeoutMs = item.timeoutMs || defaultTimeoutMs || 30000;
  var returnScreen = item.returnScreen;
  var screenRows = item.screenRows || 40;
  var waitFor = item.waitFor;
  var markerCommand = item.markerCommand;

  // A batch item must never come back before the command finished: if the caller
  // gave us no marker, mint one here (raw shells cannot carry a marker).
  if (!waitFor && shellType != "raw") {
    waitFor = makeItemMarker();
    markerCommand = markerForShellType(shellType, waitFor);
  }
  if (waitFor && !markerCommand && shellType != "raw") {
    markerCommand = markerForShellType(shellType, waitFor);
  }

  var payload = item.command;
  if (markerCommand) {
    payload = payload + "\r" + markerCommand;
  }
  xsh.Screen.Send(payload + "\r");

  if (!waitFor) {
    return { sent: true };
  }
  try {
    sleep(50);
  } catch (ePreSleep) {
  }
  if (!waitForText(waitFor, timeoutMs)) {
    // A timed-out command often leaves the shell busy or inside an interactive
    // program; without reclaiming the prompt every later request also times out.
    var recovered = false;
    if (item.recoverOnTimeout !== false) {
      try {
        interruptShell(2);
        recovered = true;
      } catch (eRecover) {
        appendBridgeLog("error", "recovery failed: " + (eRecover.message || String(eRecover)));
      }
    }
    throw (
      "Timed out waiting for: " + waitFor +
      (recovered ? " (sent Ctrl+C to reclaim the shell)" : "")
    );
  }
  if (returnScreen) {
    return { matched: waitFor, screen: readScreen(screenRows, 240) };
  }
  return { matched: waitFor };
}

function handleRequest(req) {
  if (req.op == "send") {
    xsh.Screen.Send(req.text);
    if (req.appendEnter) {
      xsh.Screen.Send("\r");
    }
    return { sent: true };
  }
  if (req.op == "read_screen") {
    var raw = readScreen(req.rows, req.columns);
    var cursorRow = null;
    try {
      cursorRow = xsh.Screen.CurrentRow;
    } catch (eCur) {
    }
    return { text: raw, cursorRow: cursorRow };
  }
  if (req.op == "wait_for") {
    if (!waitForText(req.text, req.timeoutMs || 30000)) {
      throw "Timed out waiting for: " + req.text;
    }
    return { matched: req.text };
  }
  if (req.op == "interrupt") {
    interruptShell(req.times || 2);
    return { interrupted: true, totalRecovered: totalRecovered };
  }
  if (req.op == "quit") {
    QUIT_REQUESTED = true;
    return { quitting: true };
  }
  if (req.op == "exec") {
    return executeOneItem(
      {
        command: req.command,
        shellType: "raw",
        waitFor: req.waitFor,
        markerCommand: req.markerCommand,
        timeoutMs: req.timeoutMs,
        returnScreen: req.returnScreen,
        screenRows: req.screenRows,
        recoverOnTimeout: req.recoverOnTimeout
      },
      req.timeoutMs,
      "raw"
    );
  }
  if (req.op == "batch") {
    var results = [];
    var i = 0;
    for (i = 0; i < req.items.length; i = i + 1) {
      var item = req.items[i];
      try {
        var itemResult = executeOneItem(item, req.defaultTimeoutMs, req.defaultShellType);
        results.push({ index: i, command: item.command, ok: true, result: itemResult });
      } catch (eItem) {
        // One failing command must not abort the rest of the batch.
        results.push({
          index: i,
          command: item.command,
          ok: false,
          error: eItem && eItem.message ? eItem.message : String(eItem)
        });
      }
    }
    return { items: results };
  }
  throw "Unknown operation: " + req.op;
}

function writeHeartbeatIfDue() {
  var now = new Date().getTime();
  if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
    try {
      ensureBridgeDirsIfMissing();
    } catch (eEb) {
      appendBridgeLog("error", "ensureBridgeDirsIfMissing failed: " + (eEb.message || String(eEb)));
    }
    try {
      writeStatus();
    } catch (eHb) {
      appendBridgeLog("error", "writeStatus in heartbeat failed: " + (eHb.message || String(eHb)));
    }
    lastHeartbeatAt = now;
  }
}

function clearPendingRequests() {
  try {
    var folder = fso.GetFolder(BRIDGE_DIR + BACKSLASH + "requests");
    var files = new Enumerator(folder.Files);
    var file = null;
    var name = "";
    for (; !files.atEnd(); files.moveNext()) {
      file = files.item();
      name = String(file.Name).toLowerCase();
      if (name.length >= 5 && name.substring(name.length - 5) == ".json") {
        fso.DeleteFile(file.Path, true);
      }
    }
  } catch (e) {
  }
}

function processOneRequest(filePath) {
  var req = null;
  var fallbackId = "";
  try {
    fallbackId = fso.GetBaseName(filePath);
  } catch (e0) {
    fallbackId = "unknown";
  }
  try {
    req = parseJson(readFile(filePath));
    var op = req && req.op ? String(req.op) : "(none)";
    appendBridgeLog("info", "request op=" + op + " id=" + (req && req.id ? req.id : fallbackId));
    var result = handleRequest(req);
    writeStructuredResponse(req.id, true, result);
    totalHandled = totalHandled + 1;
  } catch (e) {
    totalFailed = totalFailed + 1;
    var message = e && e.message ? e.message : (e ? String(e) : "unknown");
    appendBridgeLog("error", "request failed id=" + fallbackId + " msg=" + message);
    if (req && req.id) {
      writeStructuredResponse(req.id, false, { error: message }, message);
    } else {
      writeResponse(fallbackId, false, undefined, message);
    }
  }
  try {
    fso.DeleteFile(filePath, true);
  } catch (eDel) {
  }
}

function ensureBridgeDirsIfMissing() {
  if (!fso.FolderExists(BRIDGE_ROOT_DIR)) {
    appendBridgeLog("warn", "BRIDGE_ROOT_DIR missing, recreating: " + BRIDGE_ROOT_DIR);
    ensureBridgeDirs();
    return true;
  }
  if (!fso.FolderExists(BRIDGE_DIR)) {
    appendBridgeLog("warn", "BRIDGE_DIR missing, recreating: " + BRIDGE_DIR);
    ensureBridgeDirs();
    return true;
  }
  var reqDir = BRIDGE_DIR + BACKSLASH + "requests";
  if (!fso.FolderExists(reqDir)) {
    ensureDir(reqDir);
    appendBridgeLog("warn", "requests dir recreated: " + reqDir);
    return true;
  }
  return false;
}

function runBridgeLoop() {
  try {
    ensureBridgeDirs();
  } catch (eDirs) {
    appendBridgeLog("error", "ensureBridgeDirs failed: " + (eDirs.message || String(eDirs)));
  }
  try {
    clearPendingRequests();
  } catch (eClear) {
    appendBridgeLog("error", "clearPendingRequests failed: " + (eClear.message || String(eClear)));
  }
  try {
    writeStatus();
  } catch (eStatus) {
    appendBridgeLog("error", "writeStatus failed: " + (eStatus.message || String(eStatus)));
  }
  appendBridgeLog("info", "bridge started version=" + BRIDGE_VERSION + " pollMs=" + POLL_MS);
  promptDiag("bridge started version=" + BRIDGE_VERSION + " session=" + SESSION_ID + " source=" + SESSION_ID_SOURCE);
  if (SHOW_STARTUP_MESSAGE) {
    try {
      var msg = "Xshell MCP bridge started.\r\n" +
        "Version: " + BRIDGE_VERSION + "\r\n" +
        "Host: " + HOSTNAME + "\r\n" +
        "Session: " + SESSION_ID + " (" + SESSION_ID_SOURCE + ")" + "\r\n" +
        (SESSION_ID_COLLISION
          ? "WARNING: '" + SESSION_ID_DETECTED + "' is already used by a live bridge.\r\n" +
            "This tab uses '" + SESSION_ID + "'. Use the interactive launcher to name bastion tabs.\r\n"
          : "") +
        "Bridge root: " + BRIDGE_ROOT_DIR + "\r\n" +
        "Bridge dir: " + BRIDGE_DIR + "\r\n" +
        "Config: " + (CONFIG_PATH ? CONFIG_PATH : "(not found)") + "\r\n" +
        "Poll: " + POLL_MS + "ms";
      if (CONFIG_DIAGNOSTICS.length > 0) {
        msg += "\r\n\r\n--- resolution ---\r\n" + CONFIG_DIAGNOSTICS.join("\r\n");
      }
      xsh.Dialog.MsgBox(msg);
    } catch (e) {
    }
  }
  var consecutiveLoopErrors = 0;
  while (!QUIT_REQUESTED) {
    try {
      var folder = fso.GetFolder(BRIDGE_DIR + BACKSLASH + "requests");
      var files = new Enumerator(folder.Files);
      var file = null;
      var name = "";
      for (; !files.atEnd(); files.moveNext()) {
        file = files.item();
        name = String(file.Name).toLowerCase();
        if (name.length >= 5 && name.substring(name.length - 5) == ".json") {
          processOneRequest(file.Path);
        }
      }
      writeHeartbeatIfDue();
      // Kept inside the guard on purpose: an unguarded sleep() exception used to
      // end the script, which made the session unreachable until manually restarted.
      sleep(POLL_MS);
      consecutiveLoopErrors = 0;
    } catch (eLoop) {
      consecutiveLoopErrors = consecutiveLoopErrors + 1;
      // Log the first few, then back off to avoid flooding bridge.log every 50ms.
      if (consecutiveLoopErrors <= 5 || consecutiveLoopErrors % 100 === 0) {
        appendBridgeLog(
          "error",
          "loop error x" + consecutiveLoopErrors + ": " + (eLoop && eLoop.message ? eLoop.message : String(eLoop))
        );
      }
      try {
        sleep(500);
      } catch (eLoopSleep) {
      }
    }
  }
  appendBridgeLog("info", "bridge stopped by request after " + totalHandled + " requests");
  try {
    writeStatus();
  } catch (eFinal) {
  }
}

runBridgeLoop();
