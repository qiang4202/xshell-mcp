// End-to-end check of bridge.js inside the real JScript engine: feed it a
// request file, then assert on the response it writes back.
//
// This is what catches behavioural regressions that a syntax check cannot --
// e.g. batch items that never waited for their completion marker.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostScript = path.join(here, "jscript-bridge-host.js");
const bridgePath = process.argv[2] || path.resolve(here, "..", "xshell", "bridge.js");

if (process.platform !== "win32") {
  console.log("skip: bridge functional check only runs on Windows");
  process.exit(0);
}

let failures = 0;

function runRequest(name, request, throwSleeps = 0) {
  process.stdout.write(`  ... ${name}\n`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xshell-bridge-"));
  const sessionId = "probe";
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(path.join(sessionDir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "responses"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "logs"), { recursive: true });

  const requestFile = path.join(root, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify(request), "utf8");

  let output;
  try {
    output = execFileSync(
      "cscript",
      [
        "/E:JScript",
        "/Nologo",
        hostScript,
        bridgePath,
        root,
        sessionId,
        requestFile,
        path.join(sessionDir, "responses"),
        String(throwSleeps),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  fs.rmSync(root, { recursive: true, force: true });
  return output;
}

function ctrlCCount(output) {
  const match = output.match(/^CTRLC=(\d+)$/m);
  return match ? Number(match[1]) : -1;
}

function extract(output, begin, end) {
  const start = output.indexOf(begin);
  const stop = output.indexOf(end);
  if (start < 0 || stop < 0) return null;
  return output.slice(start + begin.length, stop).trim();
}

function parseResponse(output) {
  const raw = extract(output, "RESPONSE_BEGIN", "RESPONSE_END");
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function check(label, condition, detail = "") {
  console.log(`${condition ? "OK  " : "FAIL"}  ${label}${condition || !detail ? "" : `  -> ${detail}`}`);
  if (!condition) failures += 1;
}

// --- exec: must echo the marker and return the captured screen -------------
{
  const output = runRequest("exec", {
    id: "probe",
    op: "exec",
    command: "echo hello",
    waitFor: "__XSHELL_MCP_DONE_exec__",
    markerCommand: "echo '__XSHELL_MCP_DONE_exec__'",
    timeoutMs: 5000,
    returnScreen: true,
    screenRows: 40,
  });

  const response = parseResponse(output);
  const sent = extract(output, "SENT_BEGIN", "SENT_END") ?? "";
  console.log("\n[exec]");
  check("response written", response !== null, output.trim().split("\n")[0]);
  check("response ok", response?.ok === true, JSON.stringify(response));
  check("marker echoed to terminal", sent.includes("__XSHELL_MCP_DONE_exec__"));
  check(
    "returns matched + screen",
    typeof response?.result?.matched === "string" && typeof response?.result?.screen === "string",
    JSON.stringify(response?.result),
  );
}

// --- batch without waitFor: every item must still wait --------------------
{
  const output = runRequest("batch", {
    id: "probe",
    op: "batch",
    items: [
      { command: "echo one", shellType: "posix", timeoutMs: 5000, returnScreen: true, screenRows: 40 },
      { command: "echo two", shellType: "posix", timeoutMs: 5000, returnScreen: false, screenRows: 40 },
    ],
    defaultTimeoutMs: 5000,
    defaultShellType: "posix",
  });

  const response = parseResponse(output);
  const sent = extract(output, "SENT_BEGIN", "SENT_END") ?? "";
  const items = response?.result?.items ?? [];
  console.log("\n[batch without explicit waitFor]");
  check("response written", response !== null, output.trim().split("\n")[0]);
  check("two items returned", items.length === 2, JSON.stringify(items));
  check(
    "both items reported ok",
    items.length === 2 && items.every((item) => item.ok === true),
    JSON.stringify(items),
  );
  check("item 0 carried an auto marker", sent.includes("__XSHELL_MCP_DONE_"));
  check("each item got its own marker", (sent.match(/__XSHELL_MCP_DONE_/g) ?? []).length >= 2, sent);
  check(
    "no item short-circuited to {sent:true}",
    items.every((item) => item.result?.sent !== true),
    JSON.stringify(items),
  );
  check(
    "every item waited for a distinct marker",
    items.length === 2 &&
      items[0].result?.matched !== undefined &&
      items[1].result?.matched !== undefined &&
      items[0].result.matched !== items[1].result.matched,
    JSON.stringify(items.map((item) => item.result?.matched)),
  );
}

// --- batch item failure must not abort the rest ---------------------------
{
  const output = runRequest("batch-partial", {
    id: "probe",
    op: "batch",
    items: [
      // SUPPRESS_ECHO means the marker never reaches the screen -> this item times out.
      { command: "SUPPRESS_ECHO", shellType: "posix", waitFor: "MARKER_NEVER_SHOWS", timeoutMs: 600 },
      { command: "echo after", shellType: "posix", timeoutMs: 5000, returnScreen: false },
    ],
    defaultTimeoutMs: 5000,
    defaultShellType: "posix",
  });

  const response = parseResponse(output);
  const items = response?.result?.items ?? [];
  console.log("\n[batch with one timing-out item]");
  check("response written", response !== null, output.trim().split("\n")[0]);
  check("first item reported failure", items[0]?.ok === false, JSON.stringify(items[0]));
  check("failure carries an error", typeof items[0]?.error === "string", JSON.stringify(items[0]));
  check("second item still ran", items[1]?.ok === true, JSON.stringify(items[1]));
}

// --- timeout must reclaim the shell with Ctrl+C ---------------------------
{
  const output = runRequest("timeout-recover", {
    id: "probe",
    op: "exec",
    command: "SUPPRESS_ECHO",
    waitFor: "MARKER_NEVER_SHOWS",
    markerCommand: "",
    timeoutMs: 600,
    returnScreen: false,
    screenRows: 20,
    recoverOnTimeout: true,
  });

  const response = parseResponse(output);
  console.log("\n[timeout with recoverOnTimeout=true]");
  check("response written", response !== null, output.trim().split("\n")[0]);
  check("reports failure", response?.ok === false, JSON.stringify(response));
  check("error mentions Ctrl+C recovery", /Ctrl\+C/.test(response?.error ?? ""), response?.error ?? "");
  check("actually sent Ctrl+C", ctrlCCount(output) >= 2, String(ctrlCCount(output)));
}

// --- recoverOnTimeout=false must NOT touch the terminal -------------------
{
  const output = runRequest("timeout-no-recover", {
    id: "probe",
    op: "exec",
    command: "SUPPRESS_ECHO",
    waitFor: "MARKER_NEVER_SHOWS",
    markerCommand: "",
    timeoutMs: 600,
    returnScreen: false,
    screenRows: 20,
    recoverOnTimeout: false,
  });

  const response = parseResponse(output);
  console.log("\n[timeout with recoverOnTimeout=false]");
  check("reports failure", response?.ok === false, JSON.stringify(response));
  check("sent no Ctrl+C", ctrlCCount(output) === 0, String(ctrlCCount(output)));
}

// --- interrupt op --------------------------------------------------------
{
  const output = runRequest("interrupt", { id: "probe", op: "interrupt", times: 2 });
  const response = parseResponse(output);
  console.log("\n[interrupt op]");
  check("response ok", response?.ok === true, JSON.stringify(response));
  check("reports interrupted", response?.result?.interrupted === true, JSON.stringify(response?.result));
  check("sent Ctrl+C", ctrlCCount(output) >= 2, String(ctrlCCount(output)));
}

// --- quit op must end the loop ------------------------------------------
{
  const output = runRequest("quit", { id: "probe", op: "quit" });
  const response = parseResponse(output);
  console.log("\n[quit op]");
  check("response ok", response?.ok === true, JSON.stringify(response));
  check("reports quitting", response?.result?.quitting === true, JSON.stringify(response?.result));
  // The loop exits on its own, so the harness must NOT have had to kill it.
  check("loop exited without HARNESS_STOP", !output.includes("HARNESS_STOP"), output.trim().split("\n")[0]);
}

// --- loop must survive a throwing sleep ---------------------------------
{
  // The first few sleeps throw; the loop must absorb it and still serve the request.
  const output = runRequest(
    "sleep-throw",
    {
      id: "probe",
      op: "exec",
      command: "echo resilient",
      waitFor: "__XSHELL_MCP_DONE_resilient__",
      markerCommand: "echo '__XSHELL_MCP_DONE_resilient__'",
      timeoutMs: 5000,
      returnScreen: false,
      screenRows: 20,
      recoverOnTimeout: true,
    },
    3,
  );

  const response = parseResponse(output);
  console.log("\n[throwing sleep must not kill the loop]");
  check("response written despite sleep failures", response !== null, output.trim().split("\n")[0]);
  check("request still handled", response?.ok === true, JSON.stringify(response));
}

console.log(`\n${failures === 0 ? "ALL BEHAVIOUR CHECKS PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
