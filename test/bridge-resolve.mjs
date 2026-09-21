// Verifies bridge.js path/config resolution by executing its real source
// with Xshell's ActiveX + xsh host stubbed out.
import fs from "node:fs";
import path from "node:path";

const BRIDGE_FILE = process.argv[2] || "D:\\mcp\\xshell-mcp\\xshell\\bridge.js";

function makeFso(opts = {}) {
  return {
    FileExists: (p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    },
    FolderExists: (p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    },
    CreateFolder: (p) => fs.mkdirSync(p, { recursive: true }),
    DeleteFile: (p) => { try { fs.unlinkSync(p); } catch {} },
    MoveFile: (a, b) => {
      if (fs.existsSync(b)) { try { fs.unlinkSync(b); } catch {} }
      fs.renameSync(a, b);
    },
    GetBaseName: (p) => path.basename(p, path.extname(p)),
    DriveExists: (d) => {
      if (opts.noDriveExists) return false;
      try { return fs.existsSync(d + "\\"); } catch { return false; }
    },
    GetSpecialFolder: () => {
      if (opts.noSpecialFolder) throw new Error("not supported");
      return process.env.TEMP || "C:\\Users\\setchio\\AppData\\Local\\Temp";
    },
    GetFolder: () => ({
      Files: { atEnd: () => true, moveNext: () => {}, item: () => null },
    }),
    OpenTextFile: (p, mode, create, fmt) => {
      if (mode === 1) {
        return { ReadAll: () => fs.readFileSync(p, fmt === -1 ? "utf16le" : "utf8"), Close: () => {} };
      }
      if (mode === 2 || mode === 8) {
        const buf = [];
        return {
          Write: (t) => buf.push(t),
          Close: () => fs.writeFileSync(p, buf.join(""), fmt === -1 ? "utf16le" : "utf8"),
        };
      }
      throw new Error("unsupported OpenTextFile mode " + mode);
    },
  };
}

function makeWsh(env, opts = {}) {
  if (opts.unavailable) {
    return undefined;
  }
  return {
    Environment: (scope) => ({
      Item: (name) => {
        if (String(scope).toLowerCase() === "process") return env[name] ?? "";
        return "";
      },
    }),
    LogEvent: () => {},
  };
}

function runCase({ env = {}, override = {}, fsoOpts = {}, wshOpts = {} }) {
  const source = fs
    .readFileSync(BRIDGE_FILE, "utf8")
    .replace(/runBridgeLoop\(\);\s*$/, "/* loop disabled for test */")
    .replace(/new ActiveXObject\("Scripting\.FileSystemObject"\)/g, "__fso")
    .replace(/new ActiveXObject\("WScript\.Shell"\)/g, "__wsh");

  const overrideCode = Object.entries(override)
    .map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`)
    .join("\n");

  const code = `
    var __fso = __fsoArg;
    var __wsh = __wshArg;
    var xsh = { Session: {}, Dialog: {}, Screen: {} };
    var Enumerator = function (o) { return o; };
    ${overrideCode}
    ${source}
    __out.CONFIG_PATH = CONFIG_PATH;
    __out.BRIDGE_ROOT_DIR = BRIDGE_ROOT_DIR;
    __out.BRIDGE_DIR = BRIDGE_DIR;
    __out.DIAG = CONFIG_DIAGNOSTICS;
  `;

  const out = {};
  new Function("__fsoArg", "__wshArg", "__out", code)(
    makeFso(fsoOpts),
    makeWsh(env, wshOpts),
    out,
  );
  return out;
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
  console.log(`        actual   = ${JSON.stringify(actual)}`);
  if (!ok) {
    console.log(`        expected = ${JSON.stringify(expected)}`);
    failures += 1;
  }
}

function rootFromConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return cfg.bridgeRootDir;
}

const PROJECT_ROOT = path.dirname(path.dirname(BRIDGE_FILE));
const PROJECT_CONFIG = path.join(PROJECT_ROOT, "xshell-mcp.config.json");
const CONFIG_EXISTS = fs.existsSync(PROJECT_CONFIG);

console.log(`bridge.js:    ${BRIDGE_FILE}`);
console.log(`project cfg:  ${PROJECT_CONFIG} (${CONFIG_EXISTS ? "exists" : "MISSING"})`);
console.log("");

// Case 1: launcher injects CONFIG_PATH_OVERRIDE -> must be honoured verbatim
{
  const r = runCase({ override: { CONFIG_PATH_OVERRIDE: PROJECT_CONFIG } });
  check("override -> CONFIG_PATH", r.CONFIG_PATH, PROJECT_CONFIG);
  if (CONFIG_EXISTS) {
    check("override -> BRIDGE_ROOT_DIR", r.BRIDGE_ROOT_DIR, rootFromConfig(PROJECT_CONFIG));
  }
}

// Case 2: process env var -> must be honoured verbatim
{
  const r = runCase({ env: { XSHELL_MCP_CONFIG: PROJECT_CONFIG } });
  check("env var -> CONFIG_PATH", r.CONFIG_PATH, PROJECT_CONFIG);
  if (CONFIG_EXISTS) {
    check("env var -> BRIDGE_ROOT_DIR", r.BRIDGE_ROOT_DIR, rootFromConfig(PROJECT_CONFIG));
  }
}

// Case 3: no hints -> discovery must land on an existing config file
{
  const r = runCase({ env: {} });
  const found = String(r.CONFIG_PATH);
  check("discovery -> CONFIG_PATH is a real file", fs.existsSync(found), true);
  check("discovery -> BRIDGE_ROOT_DIR matches that config", r.BRIDGE_ROOT_DIR, rootFromConfig(found));
  check("discovery -> BRIDGE_ROOT_DIR is absolute", /^[A-Za-z]:/.test(String(r.BRIDGE_ROOT_DIR)), true);
}

// Case 4: WScript.Shell unavailable -> FSO-only path must still resolve
{
  const r = runCase({ env: {}, wshOpts: { unavailable: true } });
  const found = String(r.CONFIG_PATH);
  check("no WScript.Shell -> CONFIG_PATH is a real file", fs.existsSync(found), true);
  check("no WScript.Shell -> BRIDGE_ROOT_DIR matches that config", r.BRIDGE_ROOT_DIR, rootFromConfig(found));
}

// Case 5: never fall back to a relative "." path (the Xshell sessions dir)
{
  const r = runCase({ env: {} });
  check("BRIDGE_ROOT_DIR never relative", /^[A-Za-z]:/.test(String(r.BRIDGE_ROOT_DIR)), true);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
