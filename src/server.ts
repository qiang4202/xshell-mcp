import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  applyScreenOptions,
  builtinDangerousCommandPatternSources,
  escapeRegExp,
  extractBridgeError,
  formatExecResult,
  getSessionLiveness,
  getStatusString,
  markerForShell,
  normalizeBatchItems,
  normalizeSessionLabels,
  resolveSessionLabel,
  sanitizeSessionId,
  stripAnsi,
  stripBom,
} from "./pure.js";

type BridgeRequest =
  | { id: string; op: "send"; text: string; appendEnter: boolean }
  | {
      id: string;
      op: "read_screen";
      rows: number;
      columns: number;
      mode: "full" | "tail";
      tailRows: number;
      stripAnsi: boolean;
      includeCursor: boolean;
    }
  | {
      id: string;
      op: "wait_for";
      text: string;
      timeoutMs: number;
    }
  | {
      id: string;
      op: "exec";
      command: string;
      waitFor: string;
      timeoutMs: number;
      markerCommand: string;
      returnScreen: boolean;
      screenRows: number;
      recoverOnTimeout: boolean;
    }
  | {
      id: string;
      op: "batch";
      items: Array<{
        command: string;
        shellType: ShellType;
        waitFor: string;
        markerCommand: string;
        timeoutMs: number;
        returnScreen: boolean;
        screenRows: number;
        recoverOnTimeout: boolean;
      }>;
      defaultTimeoutMs: number;
      defaultShellType: ShellType;
    }
  | { id: string; op: "interrupt"; times: number }
  | { id: string; op: "quit" };

type BridgeResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type ConfigFile = {
  bridgeRootDir?: string;
  defaultSessionId?: string;
  // Session id -> human-readable target description (bastion/jump-host mode).
  sessionLabels?: Record<string, string>;
  sessionStaleAfterMs?: number;
  statusCacheTtlMs?: number;
  pollMs?: number;
  transport?: "stdio" | "http";
  httpPort?: number;
  dangerousCommands?: {
    builtinRulesEnabled?: boolean;
    blockedPatterns?: string[];
    blockedLiterals?: string[];
  };
};

type ShellType = "posix" | "cmd" | "powershell" | "raw";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRootDir = path.resolve(serverDir, "..");

function parseConfigFile(text: string, configPath: string): ConfigFile {
  try {
    return JSON.parse(stripBom(text)) as ConfigFile;
  } catch (error) {
    throw new Error(`Failed to parse config file ${configPath}: ${(error as Error).message}`);
  }
}

async function loadConfig() {
  const explicitConfigPath = process.env.XSHELL_MCP_CONFIG
    ? path.resolve(process.env.XSHELL_MCP_CONFIG)
    : undefined;
  const configPaths = explicitConfigPath
    ? [explicitConfigPath]
    : [path.resolve("xshell-mcp.config.json"), path.join(projectRootDir, "xshell-mcp.config.json")];

  for (const configPath of configPaths) {
    try {
      return parseConfigFile(await fs.readFile(configPath, "utf8"), configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicitConfigPath) {
        continue;
      }
      throw error;
    }
  }

  return {};
}

function resolveConfigPath(value: string | undefined, fallback: string) {
  if (!value) {
    return path.resolve(fallback);
  }
  return path.resolve(value.replace(/^~/, os.homedir()));
}

function compilePattern(source: string) {
  try {
    return new RegExp(source, "i");
  } catch (error) {
    throw new Error(`Invalid dangerous command pattern "${source}": ${(error as Error).message}`);
  }
}

const config = await loadConfig();
const bridgeRootDir = resolveConfigPath(
  process.env.XSHELL_MCP_BRIDGE_DIR ?? config.bridgeRootDir,
  path.join(os.homedir(), "Documents", "xshell-mcp-bridge"),
);
const defaultSessionId = process.env.XSHELL_MCP_DEFAULT_SESSION ?? config.defaultSessionId ?? "default";
const sessionStaleAfterMs = Number(
  process.env.XSHELL_MCP_SESSION_STALE_AFTER_MS ?? config.sessionStaleAfterMs ?? 30_000,
);
const statusCacheTtlMs = Number(config.statusCacheTtlMs ?? 1_000);
const serverPollMs = Number(config.pollMs ?? 30);
// Operators label bastion targets here so agents can map a stable session id
// (e.g. "web-01") to the real machine it points at.
const sessionLabels = normalizeSessionLabels(config.sessionLabels ?? {});
const dangerousCommandConfig = config.dangerousCommands ?? {};
const configuredPatternSources = dangerousCommandConfig.blockedPatterns ?? [];
const configuredLiteralSources = dangerousCommandConfig.blockedLiterals ?? [];
const dangerousCommandPatterns = [
  ...(dangerousCommandConfig.builtinRulesEnabled === false
    ? []
    : builtinDangerousCommandPatternSources.map(compilePattern)),
  ...configuredPatternSources.map(compilePattern),
  ...configuredLiteralSources.map((literal) => compilePattern(escapeRegExp(literal))),
].sort((a, b) => a.source.length - b.source.length);
const dangerousCommandMatchCache = new Map<string, { matched: boolean; ts: number }>();
const DANGEROUS_CACHE_TTL_MS = 60_000;
const DANGEROUS_CACHE_MAX = 512;

function getSessionPaths(sessionIdInput?: string) {
  const sessionId = sanitizeSessionId(sessionIdInput || defaultSessionId);
  const bridgeDir = path.join(bridgeRootDir, sessionId);
  return {
    sessionId,
    bridgeDir,
    requestDir: path.join(bridgeDir, "requests"),
    responseDir: path.join(bridgeDir, "responses"),
    auditLogPath: path.join(bridgeDir, "audit.log"),
    statusPath: path.join(bridgeDir, "status.json"),
  };
}

async function ensureBridgeDirs(sessionIdInput?: string) {
  const paths = getSessionPaths(sessionIdInput);
  await fs.mkdir(paths.requestDir, { recursive: true });
  await fs.mkdir(paths.responseDir, { recursive: true });
  return paths;
}

async function appendAudit(
  sessionId: string | undefined,
  event: Record<string, unknown>,
  meta: { durationMs?: number; responseBytes?: number; errorClass?: string } = {},
) {
  try {
    const paths = await ensureBridgeDirs(sessionId);
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: paths.sessionId,
      ...event,
      ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta.responseBytes !== undefined ? { responseBytes: meta.responseBytes } : {}),
      ...(meta.errorClass ? { errorClass: meta.errorClass } : {}),
    };
    await fs.appendFile(paths.auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    process.stderr.write(`audit log failed: ${(error as Error).message}\n`);
  }
}

function classifyError(error: unknown): string {
  const msg = (error as Error)?.message ?? String(error);
  if (msg.includes("Timed out")) return "timeout";
  if (msg.includes("Blocked potentially dangerous")) return "blocked_command";
  if (msg.includes("Xshell bridge")) return "bridge_error";
  return "internal_error";
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, "utf16le");
  return JSON.parse(stripBom(text)) as T;
}

async function waitForResponse(
  responseDir: string,
  id: string,
  timeoutMs: number,
): Promise<BridgeResponse> {
  const responsePath = path.join(responseDir, `${id}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await readJson<BridgeResponse>(responsePath);
      await fs.rm(responsePath, { force: true });
      return response;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, serverPollMs));
    }
  }

  throw new Error(`Timed out waiting for Xshell bridge response after ${timeoutMs} ms.`);
}

async function assertBridgeAlive(sessionId: string | undefined) {
  // `quit` is precisely what the caller wants to do to a stopped bridge.
  const paths = getSessionPaths(sessionId);
  try {
    const raw = stripBom(await fs.readFile(paths.statusPath, "utf16le"));
    const liveness = getSessionLiveness(JSON.parse(raw), sessionStaleAfterMs);
    if (liveness.state === "stale") {
      throw new Error(
        [
          `Xshell bridge for session "${paths.sessionId}" is not running (last heartbeat ${liveness.ageMs ?? "?"} ms ago).`,
          `Start it by running this inside the matching Xshell tab: ${paths.bridgeDir.replace(/[^\\]*$/, "")}..\\sessions\\${paths.sessionId}.js`,
          "If the tab is frozen, run xshell_interrupt first; if a bridge loop is still holding the tab, run xshell_bridge_stop then re-run the launcher.",
        ].join("\n"),
      );
    }
  } catch (error) {
    // Missing status.json is expected while the bridge is still booting.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function callBridge(sessionId: string | undefined, request: BridgeRequest, timeoutMs = 30_000) {
  if (request.op !== "quit") {
    await assertBridgeAlive(sessionId);
  }
  const paths = await ensureBridgeDirs(sessionId);
  await writeJsonAtomic(path.join(paths.requestDir, `${request.id}.json`), request);
  let response: BridgeResponse;
  try {
    response = await waitForResponse(paths.responseDir, request.id, timeoutMs);
  } catch (error) {
    await fs.rm(path.join(paths.requestDir, `${request.id}.json`), { force: true });
    if ((error as Error).message.includes("Timed out waiting for Xshell bridge response")) {
      throw new Error(
        `${(error as Error).message} The bridge may be busy with a long command, or the tab may be stuck in an interactive program — try xshell_interrupt, or check ${paths.bridgeDir}\\logs\\bridge.log.`,
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(extractBridgeError(response) ?? "Xshell bridge returned an unknown error.");
  }

  return response.result;
}

function assertCommandAllowed(command: string, allowDangerous: boolean) {
  if (allowDangerous) {
    return;
  }

  const compactCommand = command.replace(/\s+/g, " ").trim();

  const cached = dangerousCommandMatchCache.get(compactCommand);
  const now = Date.now();
  if (cached && now - cached.ts < DANGEROUS_CACHE_TTL_MS) {
    if (cached.matched) {
      throw new Error(
        `Blocked potentially dangerous command. Re-run with allowDangerous=true only if you explicitly approve it: ${compactCommand}`,
      );
    }
    return;
  }

  const matchedPattern = dangerousCommandPatterns.find((pattern) => pattern.test(compactCommand));
  const matched = Boolean(matchedPattern);

  if (dangerousCommandMatchCache.size >= DANGEROUS_CACHE_MAX) {
    const oldestKey = dangerousCommandMatchCache.keys().next().value;
    if (oldestKey !== undefined) {
      dangerousCommandMatchCache.delete(oldestKey);
    }
  }
  dangerousCommandMatchCache.set(compactCommand, { matched, ts: now });

  if (matched) {
    throw new Error(
      `Blocked potentially dangerous command. Re-run with allowDangerous=true only if you explicitly approve it: ${compactCommand}`,
    );
  }
}

type StatusCacheEntry = {
  status: unknown;
  liveness: ReturnType<typeof getSessionLiveness>;
  fetchedAt: number;
};

const statusCache = new Map<string, StatusCacheEntry>();

async function readStatusCached(paths: ReturnType<typeof getSessionPaths>): Promise<{
  status: unknown;
  liveness: ReturnType<typeof getSessionLiveness>;
  statusText: string;
}> {
  const cached = statusCache.get(paths.sessionId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < statusCacheTtlMs) {
    const statusText = typeof cached.status === "object" && cached.status
      ? JSON.stringify(cached.status)
      : "(cached)";
    return { status: cached.status, liveness: cached.liveness, statusText };
  }

  let statusText = "No status.json found. Start bridge.js inside the Xshell session.";
  let status: unknown = null;
  try {
    const raw = stripBom(await fs.readFile(paths.statusPath, "utf16le"));
    statusText = raw;
    status = JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      status = { error: (error as Error).message };
    }
  }
  const liveness = getSessionLiveness(status, sessionStaleAfterMs);
  statusCache.set(paths.sessionId, { status, liveness, fetchedAt: now });
  return { status, liveness, statusText };
}

function invalidateStatusCache(sessionId?: string) {
  if (!sessionId) {
    statusCache.clear();
    return;
  }
  statusCache.delete(sessionId);
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

const server = new McpServer({
  name: "xshell-mcp",
  version: "0.3.0",
});

server.tool(
  "xshell_list_sessions",
  "List Xshell MCP sessions that have written status.json under the bridge root. Includes label/sessionSource so agents can map a session id to a real target (important behind bastion hosts).",
  {
    includeStale: z.boolean().default(false),
  },
  async ({ includeStale }) => {
    await fs.mkdir(bridgeRootDir, { recursive: true });
    const entries = await fs.readdir(bridgeRootDir, { withFileTypes: true });
    const sessions = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const paths = getSessionPaths(entry.name);
      try {
        await fs.access(paths.statusPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const cached = await readStatusCached(paths);
      if (cached.liveness.state === "stale" && !includeStale) {
        continue;
      }
      // Surface enough metadata for an agent to tell bastion targets apart:
      // label/displayName come from config, sessionSource distinguishes an
      // operator-typed id from an ambiguous auto-detected jump-host name.
      const label = resolveSessionLabel(entry.name, cached.status, sessionLabels);
      sessions.push({
        sessionId: entry.name,
        label: label ?? null,
        displayName: label ? `${entry.name} (${label})` : entry.name,
        sessionSource: getStatusString(cached.status, "sessionSource") ?? null,
        detectedSessionId: getStatusString(cached.status, "detectedSessionId") ?? null,
        hostname: getStatusString(cached.status, "hostname") ?? null,
        remoteAddress: getStatusString(cached.status, "remoteAddress") ?? null,
        remotePort: getStatusString(cached.status, "remotePort") ?? null,
        bridgeDir: paths.bridgeDir,
        liveness: cached.liveness,
        status: cached.status,
      });
    }

    return textResult(JSON.stringify(sessions, null, 2));
  },
);

server.tool(
  "xshell_prune_session",
  "Recursively remove a session's bridge directory. Use after the Xshell tab is closed.",
  {
    sessionId: z.string().default(defaultSessionId),
  },
  async ({ sessionId }) => {
    const paths = getSessionPaths(sessionId);
    await fs.rm(paths.bridgeDir, { recursive: true, force: true });
    invalidateStatusCache(paths.sessionId);
    return textResult(`Pruned session directory: ${paths.bridgeDir}`);
  },
);

server.tool(
  "xshell_status",
  "Show the bridge directory and setup status for an Xshell MCP session.",
  {
    sessionId: z.string().default(defaultSessionId),
  },
  async ({ sessionId }) => {
    const paths = await ensureBridgeDirs(sessionId);
    const cached = await readStatusCached(paths);
    const livenessText = `${cached.liveness.state} ageMs=${cached.liveness.ageMs ?? "unknown"} staleAfterMs=${cached.liveness.staleAfterMs}`;
    const label = resolveSessionLabel(paths.sessionId, cached.status, sessionLabels);
    const source = getStatusString(cached.status, "sessionSource") ?? "unknown";
    const detected = getStatusString(cached.status, "detectedSessionId") || "-";
    const remoteAddress = getStatusString(cached.status, "remoteAddress") || "-";
    const remotePort = getStatusString(cached.status, "remotePort");
    return textResult(
      [
        `Xshell MCP session: ${paths.sessionId}`,
        `Label: ${label ?? "-"}`,
        `Session source: ${source}`,
        `Detected id: ${detected}`,
        `Remote: ${remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress}`,
        `Bridge root: ${bridgeRootDir}`,
        `Bridge directory: ${paths.bridgeDir}`,
        `Requests: ${paths.requestDir}`,
        `Responses: ${paths.responseDir}`,
        `Audit log: ${paths.auditLogPath}`,
        `Liveness: ${livenessText}`,
        `Status: ${cached.statusText}`,
      ].join("\n"),
    );
  },
);

server.tool(
  "xshell_send",
  "Send text to the active Xshell terminal session.",
  {
    sessionId: z.string().default(defaultSessionId),
    text: z.string().describe("Text to send to Xshell."),
    appendEnter: z.boolean().default(true).describe("Append Enter after sending the text."),
    allowDangerous: z.boolean().default(false).describe("Allow commands that match dangerous patterns."),
    timeoutMs: z.number().int().positive().default(10_000),
  },
  async ({ sessionId, text, appendEnter, allowDangerous, timeoutMs }) => {
    const id = randomUUID();
    const startedAt = Date.now();
    await appendAudit(sessionId, {
      id,
      tool: "xshell_send",
      text,
      appendEnter,
      allowDangerous,
      status: "started",
    });

    try {
      if (appendEnter) {
        assertCommandAllowed(text, allowDangerous);
      }
      await callBridge(sessionId, { id, op: "send", text, appendEnter }, timeoutMs);
      await appendAudit(
        sessionId,
        { id, tool: "xshell_send", status: "completed" },
        { durationMs: Date.now() - startedAt },
      );
      return textResult("Sent.");
    } catch (error) {
      await appendAudit(
        sessionId,
        { id, tool: "xshell_send", status: "failed", error: (error as Error).message },
        {
          durationMs: Date.now() - startedAt,
          errorClass: classifyError(error),
        },
      );
      throw error;
    }
  },
);

server.tool(
  "xshell_read_screen",
  "Read text from the active Xshell screen buffer.",
  {
    sessionId: z.string().default(defaultSessionId),
    rows: z.number().int().positive().max(200).default(60),
    columns: z.number().int().positive().max(400).default(200),
    mode: z.enum(["full", "tail"]).default("full"),
    tailRows: z.number().int().positive().max(200).default(30),
    stripAnsi: z.boolean().default(true),
    includeCursor: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(10_000),
  },
  async ({ sessionId, rows, columns, mode, tailRows, stripAnsi, includeCursor, timeoutMs }) => {
    const id = randomUUID();
    const startedAt = Date.now();
    const result = (await callBridge(
      sessionId,
      {
        id,
        op: "read_screen",
        rows,
        columns,
        mode,
        tailRows,
        stripAnsi,
        includeCursor,
      },
      timeoutMs,
    )) as { text: string; cursorRow?: number } | string;

    const rawText = typeof result === "object" && result && "text" in result ? result.text : String(result ?? "");
    const optimized = applyScreenOptions(rawText, mode, tailRows, stripAnsi);

    const responseBytes = Buffer.byteLength(optimized, "utf8");
    await appendAudit(
      sessionId,
      { id, tool: "xshell_read_screen", status: "completed", mode, tailRows },
      { durationMs: Date.now() - startedAt, responseBytes },
    );

    if (includeCursor && typeof result === "object" && result && "cursorRow" in result) {
      return textResult(`cursorRow=${result.cursorRow}\n${optimized}`);
    }
    return textResult(optimized);
  },
);

server.tool(
  "xshell_wait_for",
  "Wait until the active Xshell terminal shows the given text.",
  {
    sessionId: z.string().default(defaultSessionId),
    text: z.string(),
    timeoutMs: z.number().int().positive().default(30_000),
  },
  async ({ sessionId, text, timeoutMs }) => {
    const id = randomUUID();
    const startedAt = Date.now();
    try {
      const result = await callBridge(
        sessionId,
        { id, op: "wait_for", text, timeoutMs },
        timeoutMs + 5_000,
      );
      await appendAudit(
        sessionId,
        { id, tool: "xshell_wait_for", text, status: "completed" },
        { durationMs: Date.now() - startedAt },
      );
      return textResult(String(result ?? "Matched."));
    } catch (error) {
      await appendAudit(
        sessionId,
        { id, tool: "xshell_wait_for", text, status: "failed", error: (error as Error).message },
        { durationMs: Date.now() - startedAt, errorClass: classifyError(error) },
      );
      throw error;
    }
  },
);

server.tool(
  "xshell_exec",
  "Send a command to Xshell, wait for the completion marker, and return the tail of the output.",
  {
    sessionId: z.string().default(defaultSessionId),
    command: z.string(),
    waitFor: z.string().default("__XSHELL_MCP_DONE__").describe("Text that indicates command completion."),
    shellType: z
      .enum(["posix", "cmd", "powershell", "raw"])
      .default("posix")
      .describe("Shell syntax used to append the completion marker."),
    allowDangerous: z.boolean().default(false).describe("Allow commands that match dangerous patterns."),
    returnScreen: z
      .boolean()
      .default(true)
      .describe("Return the captured screen tail after the marker matched."),
    screenTailRows: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(40)
      .describe("How many screen rows to return when returnScreen is true."),
    recoverOnTimeout: z
      .boolean()
      .default(true)
      .describe("On timeout, send Ctrl+C to reclaim the shell prompt instead of leaving it stuck."),
    timeoutMs: z.number().int().positive().default(30_000),
  },
  async ({
    sessionId,
    command,
    waitFor,
    shellType,
    allowDangerous,
    returnScreen,
    screenTailRows,
    recoverOnTimeout,
    timeoutMs,
  }) => {
    const id = randomUUID();
    const startedAt = Date.now();
    const usesDefaultWaitFor = waitFor === "__XSHELL_MCP_DONE__";
    // A raw shell cannot echo a marker; without an explicit waitFor there is
    // nothing to wait for, so send and return instead of timing out.
    const effectiveWaitFor =
      shellType === "raw" && usesDefaultWaitFor
        ? ""
        : usesDefaultWaitFor
          ? `__XSHELL_MCP_DONE_${id.replace(/-/g, "_")}__`
          : waitFor;
    const markerCommand = effectiveWaitFor ? markerForShell(shellType, effectiveWaitFor) : "";
    await appendAudit(sessionId, {
      id,
      tool: "xshell_exec",
      command,
      waitFor: effectiveWaitFor,
      shellType,
      allowDangerous,
      returnScreen,
      status: "started",
    });

    try {
      assertCommandAllowed(command, allowDangerous);
      const result = await callBridge(
        sessionId,
        {
          id,
          op: "exec",
          command,
          waitFor: effectiveWaitFor,
          markerCommand,
          timeoutMs,
          returnScreen,
          screenRows: screenTailRows,
          recoverOnTimeout,
        },
        timeoutMs + 5_000,
      );
      const text = formatExecResult(result);
      await appendAudit(
        sessionId,
        { id, tool: "xshell_exec", status: "completed" },
        { durationMs: Date.now() - startedAt, responseBytes: Buffer.byteLength(text, "utf8") },
      );
      return textResult(text);
    } catch (error) {
      await appendAudit(
        sessionId,
        { id, tool: "xshell_exec", status: "failed", error: (error as Error).message },
        { durationMs: Date.now() - startedAt, errorClass: classifyError(error) },
      );
      throw error;
    }
  },
);

const batchItemSchema = z.object({
  command: z.string(),
  shellType: z.enum(["posix", "cmd", "powershell", "raw"]).optional(),
  waitFor: z.string().optional().describe("Text that marks completion. Auto-generated when omitted."),
  timeoutMs: z.number().int().positive().optional(),
  returnScreen: z.boolean().default(true),
  screenTailRows: z.number().int().positive().max(200).default(40),
  recoverOnTimeout: z.boolean().default(true),
});

server.tool(
  "xshell_exec_batch",
  "Run several commands serially in one bridge round-trip. Each item waits for its own completion marker, and one failing command does not abort the rest. Pass items as a plain JSON array.",
  {
    sessionId: z.string().default(defaultSessionId),
    items: z
      .preprocess(
        normalizeBatchItems,
        z
          .array(batchItemSchema)
          .min(1)
          .describe("Plain array of {command, shellType?, waitFor?, timeoutMs?, returnScreen?, screenTailRows?}."),
      )
      .describe("Plain array of command objects. Do not wrap it in another object."),
    defaultTimeoutMs: z.number().int().positive().default(30_000),
    defaultShellType: z.enum(["posix", "cmd", "powershell", "raw"]).default("posix"),
    allowDangerous: z.boolean().default(false),
  },
  async ({ sessionId, items, defaultTimeoutMs, defaultShellType, allowDangerous }) => {
    const id = randomUUID();
    const startedAt = Date.now();
    for (const item of items) {
      assertCommandAllowed(item.command, allowDangerous);
    }

    const prepared = items.map((item, index) => {
      const shellType = item.shellType ?? defaultShellType;
      const timeoutMs = item.timeoutMs ?? defaultTimeoutMs;
      const waitFor =
        item.waitFor ??
        (shellType === "raw" ? "" : `__XSHELL_MCP_DONE_${id.replace(/-/g, "_")}_${index}__`);
      return {
        command: item.command,
        shellType,
        waitFor,
        markerCommand: waitFor ? markerForShell(shellType, waitFor) : "",
        timeoutMs,
        returnScreen: item.returnScreen,
        screenRows: item.screenTailRows,
        recoverOnTimeout: item.recoverOnTimeout,
      };
    });

    const totalTimeoutMs = prepared.reduce((acc, item) => acc + item.timeoutMs, 0) + 15_000;

    try {
      const result = (await callBridge(
        sessionId,
        {
          id,
          op: "batch",
          items: prepared,
          defaultTimeoutMs,
          defaultShellType,
        },
        totalTimeoutMs,
      )) as { items?: Array<{ index: number; command: string; ok: boolean; result?: unknown; error?: string }> };

      const lines: string[] = [];
      for (const entry of result?.items ?? []) {
        const label = `[${entry.index + 1}/${prepared.length}]`;
        if (entry.ok) {
          lines.push(`${label} ok`);
          const body = formatExecResult(entry.result);
          if (body) {
            lines.push(body.replace(/\s+$/, ""));
          }
        } else {
          lines.push(`${label} FAILED: ${entry.error ?? "unknown error"}`);
        }
        lines.push("");
      }
      const report = lines.join("\n").replace(/\n+$/, "") || "(no output)";

      await appendAudit(
        sessionId,
        { id, tool: "xshell_exec_batch", count: prepared.length, status: "completed" },
        { durationMs: Date.now() - startedAt, responseBytes: Buffer.byteLength(report, "utf8") },
      );
      return textResult(report);
    } catch (error) {
      await appendAudit(
        sessionId,
        {
          id,
          tool: "xshell_exec_batch",
          count: prepared.length,
          status: "failed",
          error: (error as Error).message,
        },
        { durationMs: Date.now() - startedAt, errorClass: classifyError(error) },
      );
      throw error;
    }
  },
);

server.tool(
  "xshell_interrupt",
  "Send Ctrl+C to the session to reclaim the shell prompt when the terminal is stuck in a running command or an interactive program.",
  {
    sessionId: z.string().default(defaultSessionId),
    times: z.number().int().positive().max(5).default(2).describe("How many Ctrl+C to send."),
    waitForPromptAfterMs: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(0)
      .describe("If greater than 0, read the screen back after interrupting."),
    timeoutMs: z.number().int().positive().default(10_000),
  },
  async ({ sessionId, times, waitForPromptAfterMs, timeoutMs }) => {
    const id = randomUUID();
    const startedAt = Date.now();
    await callBridge(sessionId, { id, op: "interrupt", times }, timeoutMs);
    let screen = "";
    if (waitForPromptAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitForPromptAfterMs));
      const readId = randomUUID();
      const readResult = (await callBridge(
        sessionId,
        {
          id: readId,
          op: "read_screen",
          rows: 20,
          columns: 200,
          mode: "tail",
          tailRows: 10,
          stripAnsi: true,
          includeCursor: false,
        },
        timeoutMs,
      )) as { text?: string } | string;
      screen =
        typeof readResult === "object" && readResult && "text" in readResult
          ? (readResult.text ?? "")
          : String(readResult ?? "");
    }
    await appendAudit(
      sessionId,
      { id, tool: "xshell_interrupt", times, status: "completed" },
      { durationMs: Date.now() - startedAt },
    );
    const summary = `Sent Ctrl+C x${times} to reclaim the prompt.`;
    return textResult(screen ? `${summary}\n\n${screen}` : summary);
  },
);

server.tool(
  "xshell_bridge_stop",
  "Ask the bridge script to exit its loop so the Xshell tab is free again (needed before re-running the bridge).",
  {
    sessionId: z.string().default(defaultSessionId),
    timeoutMs: z.number().int().positive().default(10_000),
  },
  async ({ sessionId, timeoutMs }) => {
    const id = randomUUID();
    await callBridge(sessionId, { id, op: "quit" }, timeoutMs);
    invalidateStatusCache(sessionId);
    await appendAudit(sessionId, { id, tool: "xshell_bridge_stop", status: "completed" });
    return textResult(
      [
        "Bridge loop exit requested.",
        `The Xshell tab for session "${sessionId}" is now free.`,
        "Re-run the launcher (xshell/sessions/<id>.js) to start it again.",
      ].join("\n"),
    );
  },
);

await ensureBridgeDirs(defaultSessionId);
const transportMode = process.env.XSHELL_MCP_TRANSPORT ?? config.transport ?? "stdio";

if (transportMode === "http") {
  const port = Number(process.env.XSHELL_MCP_HTTP_PORT ?? config.httpPort ?? 8765);
  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, () => {
    process.stderr.write(`xshell-mcp HTTP server listening on http://127.0.0.1:${port}\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
