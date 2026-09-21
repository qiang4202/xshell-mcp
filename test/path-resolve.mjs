const BACKSLASH = String.fromCharCode(92);

function normalizeDir(path) {
  let p = String(path);
  while (p.length > 0 && (p[p.length - 1] == BACKSLASH || p[p.length - 1] == "/")) {
    p = p.substring(0, p.length - 1);
  }
  return p;
}

function parentDir(path) {
  const p = normalizeDir(path);
  let idx = -1;
  for (let i = p.length - 1; i >= 0; i--) {
    const c = p.charAt(i);
    if (c == BACKSLASH || c == "/") {
      idx = i;
      break;
    }
  }
  return idx < 0 ? "" : p.substring(0, idx);
}

function resolveConfigPathFromScriptPath(scriptPath) {
  const p = normalizeDir(scriptPath);
  if (!p) return "";
  const xshellDir = parentDir(p);
  if (!xshellDir) return "";
  const projectRoot = parentDir(xshellDir);
  if (!projectRoot) return xshellDir + BACKSLASH + "xshell-mcp.config.json";
  return projectRoot + BACKSLASH + "xshell-mcp.config.json";
}

const cases = [
  ["D:\\mcp\\xshell-mcp\\xshell\\bridge.js", "D:\\mcp\\xshell-mcp\\xshell-mcp.config.json"],
  ["D:\\my-xshell-mcp\\xshell\\bridge.js", "D:\\my-xshell-mcp\\xshell-mcp.config.json"],
  ["D:\\anywhere\\xshell-mcp\\xshell\\bridge.js", "D:\\anywhere\\xshell-mcp\\xshell-mcp.config.json"],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const actual = resolveConfigPathFromScriptPath(input);
  const ok = actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"}  ${input.padEnd(50)} -> ${actual}${ok ? "" : "  (expected " + expected + ")"}`);
  if (ok) pass++;
  else fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
