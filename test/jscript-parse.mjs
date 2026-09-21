// Guards the Xshell-side scripts against syntax the JScript engine rejects but
// Node/TypeScript accepts -- e.g. trailing commas in object literals and call
// arguments, which surface to the user as "missing identifier".
//
// Also mirrors what the generated launcher does: read bridge.js as ASCII and
// eval it. Reading it as Unicode mangles the file, so the format flag is asserted here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = path.join(here, "jscript-parse-host.js");
const xshellDir = path.resolve(here, "..", "xshell");

function targets() {
  const list = [path.join(xshellDir, "bridge.js")];
  const sessionsDir = path.join(xshellDir, "sessions");
  if (fs.existsSync(sessionsDir)) {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (name.endsWith(".js")) {
        list.push(path.join(sessionsDir, name));
      }
    }
  }
  return list;
}

// ASCII bridge.js, UTF-16 launchers (PowerShell -Encoding Unicode).
function formatFor(file) {
  const head = fs.readFileSync(file).subarray(0, 2);
  const isUtf16 = head[0] === 0xff && head[1] === 0xfe;
  return isUtf16 ? "-1" : "0";
}

function parseWith(file) {
  const format = formatFor(file);
  try {
    const out = execFileSync("cscript", ["/E:JScript", "/Nologo", host, file, format], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ok: out.includes("PARSE_OK"), detail: out.replace("PARSE_OK", "").trim() };
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { ok: false, detail: out.trim() };
  }
}

if (process.platform !== "win32") {
  console.log("skip: JScript parse check only runs on Windows");
  process.exit(0);
}

let failures = 0;

for (const file of targets()) {
  if (!fs.existsSync(file)) {
    console.log(`MISSING     ${path.basename(file)}`);
    failures += 1;
    continue;
  }
  const { ok, detail } = parseWith(file);
  console.log(`${ok ? "PARSE_OK  " : "PARSE_FAIL"}  ${path.basename(file)}${ok ? "" : `  ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

// The launcher reads bridge.js with format 0; prove that combination compiles.
const bridge = path.join(xshellDir, "bridge.js");
if (fs.existsSync(bridge)) {
  const { ok, detail } = parseWith(bridge);
  console.log(`${ok ? "PARSE_OK  " : "PARSE_FAIL"}  (launcher path: bridge.js read as ASCII)${ok ? "" : `  ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

// Guard the encoding contract the launcher depends on.
if (fs.existsSync(bridge)) {
  const head = fs.readFileSync(bridge).subarray(0, 2);
  const hasUtf16Bom = head[0] === 0xff && head[1] === 0xfe;
  console.log(`${hasUtf16Bom ? "FAIL      " : "OK        "}  bridge.js has no UTF-16 BOM`);
  if (hasUtf16Bom) {
    failures += 1;
  }

  const raw = fs.readFileSync(bridge);
  const crlf = (raw.toString("latin1").match(/\r\n/g) ?? []).length;
  const lf = (raw.toString("latin1").match(/\n/g) ?? []).length;
  const crlfOnly = crlf === lf && lf > 0;
  console.log(`${crlfOnly ? "OK        " : "FAIL      "}  bridge.js uses CRLF endings (${crlf}/${lf})`);
  if (!crlfOnly) {
    failures += 1;
  }
}

// The UTF-16 launchers must not be treated as text by git: git only looks for
// the byte pair 0D 0A, which never appears in UTF-16LE, so text mode believes
// the file has bare LFs and injects a stray 0D on checkout, breaking the encoding.
const launchers = fs
  .readdirSync(path.join(xshellDir, "sessions"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(xshellDir, "sessions", name));

{
  const attrPath = path.resolve(xshellDir, "..", ".gitattributes");
  let attrText = "";
  try {
    attrText = fs.readFileSync(attrPath, "utf8");
  } catch {
    attrText = "";
  }
  const marksBinary = /xshell\/sessions\/\*\.js\s+binary/.test(attrText);
  console.log(`${marksBinary ? "OK        " : "FAIL      "}  .gitattributes marks session launchers as binary`);
  if (!marksBinary) {
    failures += 1;
  }
}

// Prove a checkout round-trip preserves the bytes.
{
  const utf16Launchers = launchers.filter((file) => {
    const head = fs.readFileSync(file).subarray(0, 2);
    return head[0] === 0xff && head[1] === 0xfe;
  });

  if (utf16Launchers.length === 0) {
    console.log("skip      no UTF-16 launchers to round-trip");
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xshell-co-"));
    try {
      execFileSync(
        "git",
        [
          "checkout-index",
          "-f",
          `--prefix=${tmp}${path.sep}`,
          "--",
          ...utf16Launchers.map((file) => path.relative(path.resolve(xshellDir, ".."), file)),
        ],
        { cwd: path.resolve(xshellDir, ".."), stdio: "pipe" },
      );

      for (const file of utf16Launchers) {
        const rel = path.relative(path.resolve(xshellDir, ".."), file);
        const checkedOut = path.join(tmp, rel);
        const same = fs.existsSync(checkedOut) && fs.readFileSync(checkedOut).equals(fs.readFileSync(file));
        console.log(`${same ? "OK        " : "FAIL      "}  checkout preserves ${path.basename(file)}`);
        if (!same) {
          failures += 1;
        }
      }
    } catch (error) {
      console.log(`skip      checkout round-trip unavailable (${(error.message ?? "").split("\n")[0]})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log(`\n${failures === 0 ? "ALL PARSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
