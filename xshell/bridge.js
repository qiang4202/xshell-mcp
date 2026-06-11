// Xshell MCP bridge script.
// Plain old JScript version for Xshell script host.

var POLL_MS = 150;
var HEARTBEAT_MS = 5000;
var DEFAULT_READ_ROWS = 120;
var DEFAULT_READ_COLUMNS = 240;
var SHOW_STARTUP_MESSAGE = true;
var BRIDGE_VERSION = "plain-js-20260608-2";
var BACKSLASH = String.fromCharCode(92);
var DQ = String.fromCharCode(34);
var BRIDGE_ROOT_DIR = "C:" + BACKSLASH + "Users" + BACKSLASH + "80703" + BACKSLASH + "Documents" + BACKSLASH + "xshell-mcp-bridge";

var fso = new ActiveXObject("Scripting.FileSystemObject");
var lastHeartbeatAt = 0;

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

if (typeof SESSION_ID == "undefined" || !SESSION_ID) {
  var SESSION_ID = detectSessionId();
}
if (typeof BRIDGE_ROOT_DIR_OVERRIDE != "undefined" && BRIDGE_ROOT_DIR_OVERRIDE) {
  BRIDGE_ROOT_DIR = BRIDGE_ROOT_DIR_OVERRIDE;
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
}

function readFile(filePath) {
  var file = fso.OpenTextFile(filePath, 1, false, 0);
  var text = file.ReadAll();
  file.Close();
  return text;
}

function writeFile(filePath, text) {
  var tempPath = filePath + "." + new Date().getTime() + ".tmp";
  var file = fso.OpenTextFile(tempPath, 2, true, -1);
  file.Write(text);
  file.Close();
  if (fso.FileExists(filePath)) {
    fso.DeleteFile(filePath, true);
  }
  fso.MoveFile(tempPath, filePath);
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

function pad2(value) {
  if (value < 10) {
    return "0" + value;
  }
  return String(value);
}

function nowIsoLike() {
  var date = new Date();
  var text = "";
  text += date.getFullYear();
  text += "-";
  text += pad2(date.getMonth() + 1);
  text += "-";
  text += pad2(date.getDate());
  text += "T";
  text += pad2(date.getHours());
  text += ":";
  text += pad2(date.getMinutes());
  text += ":";
  text += pad2(date.getSeconds());
  return text;
}

function writeStatus() {
  var json = "{";
  json += DQ + "ok" + DQ + ":true,";
  json += DQ + "version" + DQ + ":" + DQ + jsonEscape(BRIDGE_VERSION) + DQ + ",";
  json += DQ + "sessionId" + DQ + ":" + DQ + jsonEscape(SESSION_ID) + DQ + ",";
  json += DQ + "startedAt" + DQ + ":" + DQ + jsonEscape(STARTED_AT) + DQ + ",";
  json += DQ + "lastSeenAt" + DQ + ":" + DQ + jsonEscape(nowIsoLike()) + DQ + ",";
  json += DQ + "bridgeDir" + DQ + ":" + DQ + jsonEscape(BRIDGE_DIR) + DQ;
  json += "}";
  writeFile(BRIDGE_DIR + BACKSLASH + "status.json", json);
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
  var content = "";
  while (new Date().getTime() < deadline) {
    content = readScreen(120, 240);
    if (content.indexOf(text) >= 0) {
      return true;
    }
    sleep(200);
  }
  return false;
}

function handleRequest(req) {
  if (req.op == "send") {
    xsh.Screen.Send(req.text);
    if (req.appendEnter) {
      xsh.Screen.Send("\r");
    }
    return "sent";
  }
  if (req.op == "read_screen") {
    return readScreen(req.rows, req.columns);
  }
  if (req.op == "wait_for") {
    if (!waitForText(req.text, req.timeoutMs || 30000)) {
      throw "Timed out waiting for: " + req.text;
    }
    return "matched: " + req.text;
  }
  if (req.op == "exec") {
    var command = req.command;
    if (req.markerCommand) {
      command = command + "\r" + req.markerCommand;
    }
    xsh.Screen.Send(command);
    xsh.Screen.Send("\r");
    if (!waitForText(req.waitFor, req.timeoutMs || 30000)) {
      throw "Timed out waiting for: " + req.waitFor;
    }
    return readScreen(120, 240);
  }
  throw "Unknown operation: " + req.op;
}

function writeHeartbeatIfDue() {
  var now = new Date().getTime();
  if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
    writeStatus();
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
    var result = handleRequest(req);
    writeResponse(req.id, true, result, null);
  } catch (e) {
    if (req && req.id) {
      writeResponse(req.id, false, undefined, e.message || String(e));
    } else {
      writeResponse(fallbackId, false, undefined, e.message || String(e));
    }
  }
  fso.DeleteFile(filePath, true);
}

function runBridgeLoop() {
  ensureBridgeDirs();
  writeStatus();
  clearPendingRequests();
  if (SHOW_STARTUP_MESSAGE) {
    try {
      xsh.Dialog.MsgBox("Xshell MCP bridge started.\r\nSession: " + SESSION_ID + "\r\nBridge dir: " + BRIDGE_DIR);
    } catch (e) {
    }
  }
  while (true) {
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
    sleep(POLL_MS);
  }
}

runBridgeLoop();




