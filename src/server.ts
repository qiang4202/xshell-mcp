import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

type BridgeRequest =
  | { id: string; op: "send"; text: string; appendEnter: boolean }
  | { id: string; op: "read_screen"; rows: number; columns: number }
  | { id: string; op: "wait_for"; text: string; timeoutMs: number }
  | {
      id: string;
      op: "exec";
      command: string;
      waitFor: string;
      timeoutMs: number;
      markerCommand: string;
    };

type BridgeResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const bridgeRootDir = path.resolve(
  process.env.XSHELL_MCP_BRIDGE_DIR ??
    path.join(os.homedir(), "Documents", "xshell-mcp-bridge"),
);

const defaultSessionId = process.env.XSHELL_MCP_DEFAULT_SESSION ?? "default";
const sessionStaleAfterMs = Number(process.env.XSHELL_MCP_SESSION_STALE_AFTER_MS ?? 15_000);

const dangerousCommandPatterns = [
  /\brm\s+(-[^\s]*[rf][^\s]*|-r|-f)\s+/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+.*\bof\s*=/i,
  /\bchmod\s+(-[^\s]*R[^\s]*\s+)?777\b/i,
  /\bchown\s+(-[^\s]*R[^\s]*\s+)/i,
  /\bpasswd\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

type ShellType = "posix" | "cmd" | "powershell" | "raw";

function sanitizeSessionId(sessionId: string) {
  const trimmed = sessionId.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error("sessionId may only contain letters, numbers, dots, underscores, and hyphens.");
  }
  return trimmed;
}

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

async function appendAudit(sessionId: string | undefined, event: Record<string, unknown>) {
  const paths = await ensureBridgeDirs(sessionId);
  const entry = {
    timestamp: new Date().toISOString(),
    sessionId: paths.sessionId,
    ...event,
  };
  await fs.appendFile(paths.auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, "utf16le");
  return JSON.parse(stripBom(text)) as T;
}

function stripBom(text: string) {
  return text.replace(/^\uFEFF/, "");
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for Xshell bridge response after ${timeoutMs} ms.`);
}

async function callBridge(sessionId: string | undefined, request: BridgeRequest, timeoutMs = 30_000) {
  const paths = await ensureBridgeDirs(sessionId);
  await writeJsonAtomic(path.join(paths.requestDir, `${request.id}.json`), request);
  const response = await waitForResponse(paths.responseDir, request.id, timeoutMs);

  if (!response.ok) {
    throw new Error(response.error ?? "Xshell bridge returned an unknown error.");
  }

  return response.result;
}

function assertCommandAllowed(command: string, allowDangerous: boolean) {
  if (allowDangerous) {
    return;
  }

  const compactCommand = command.replace(/\s+/g, " ").trim();
  const matchedPattern = dangerousCommandPatterns.find((pattern) => pattern.test(compactCommand));

  if (matchedPattern) {
    throw new Error(
      `Blocked potentially dangerous command. Re-run with allowDangerous=true only if you explicitly approve it: ${compactCommand}`,
    );
  }
}

function markerForShell(shellType: ShellType, marker: string) {
  switch (shellType) {
    case "posix":
      return `echo ${shellQuotePosix(marker)}`;
    case "cmd":
      return `echo ${marker}`;
    case "powershell":
      return `Write-Output ${shellQuotePowerShell(marker)}`;
    case "raw":
      return "";
  }
}

function shellQuotePosix(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function getSessionLiveness(status: unknown) {
  const lastSeenAt =
    typeof status === "object" && status && "lastSeenAt" in status
      ? String((status as { lastSeenAt?: unknown }).lastSeenAt ?? "")
      : "";
  const startedAt =
    typeof status === "object" && status && "startedAt" in status
      ? String((status as { startedAt?: unknown }).startedAt ?? "")
      : "";
  const timestamp = Date.parse(lastSeenAt || startedAt);

  if (!Number.isFinite(timestamp)) {
    return {
      state: "unknown",
      ageMs: null,
      staleAfterMs: sessionStaleAfterMs,
    };
  }

  const ageMs = Date.now() - timestamp;
  return {
    state: ageMs <= sessionStaleAfterMs ? "online" : "stale",
    ageMs,
    staleAfterMs: sessionStaleAfterMs,
  };
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
  version: "0.1.0",
});

server.tool(
  "xshell_list_sessions",
  "List Xshell MCP sessions that have written status.json under the bridge root.",
  {},
  async () => {
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

      let status: unknown = null;
      try {
        status = JSON.parse(stripBom(await fs.readFile(paths.statusPath, "utf16le")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          status = { error: (error as Error).message };
        }
      }

      const liveness = getSessionLiveness(status);
      if (liveness.state === "stale") {
        await fs.rm(paths.bridgeDir, { recursive: true, force: true });
        continue;
      }

      sessions.push({
        sessionId: entry.name,
        bridgeDir: paths.bridgeDir,
        liveness,
        status,
      });
    }

    return textResult(JSON.stringify(sessions, null, 2));
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
    let statusText = "No status.json found. Start bridge.js inside the Xshell session.";
    let livenessText = "unknown";
    try {
      const rawStatus = stripBom(await fs.readFile(paths.statusPath, "utf16le"));
      statusText = rawStatus;
      const statusJson = JSON.parse(rawStatus);
      const liveness = getSessionLiveness(statusJson);
      livenessText = `${liveness.state} ageMs=${liveness.ageMs ?? "unknown"} staleAfterMs=${liveness.staleAfterMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return textResult(
      [
        `Xshell MCP session: ${paths.sessionId}`,
        `Bridge root: ${bridgeRootDir}`,
        `Bridge directory: ${paths.bridgeDir}`,
        `Requests: ${paths.requestDir}`,
        `Responses: ${paths.responseDir}`,
        `Audit log: ${paths.auditLogPath}`,
        `Liveness: ${livenessText}`,
        `Status: ${statusText}`,
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
      await appendAudit(sessionId, { id, tool: "xshell_send", status: "completed" });
      return textResult("Sent.");
    } catch (error) {
      await appendAudit(sessionId, {
        id,
        tool: "xshell_send",
        status: "failed",
        error: (error as Error).message,
      });
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
    timeoutMs: z.number().int().positive().default(10_000),
  },
  async ({ sessionId, rows, columns, timeoutMs }) => {
    const id = randomUUID();
    const result = await callBridge(sessionId, { id, op: "read_screen", rows, columns }, timeoutMs);
    return textResult(String(result ?? ""));
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
    const result = await callBridge(
      sessionId,
      { id, op: "wait_for", text, timeoutMs },
      timeoutMs + 5_000,
    );
    return textResult(String(result ?? "Matched."));
  },
);

server.tool(
  "xshell_exec",
  "Send a command to Xshell and wait for a prompt or automatic completion marker.",
  {
    sessionId: z.string().default(defaultSessionId),
    command: z.string(),
    waitFor: z.string().default("__XSHELL_MCP_DONE__").describe("Text that indicates command completion."),
    shellType: z
      .enum(["posix", "cmd", "powershell", "raw"])
      .default("posix")
      .describe("Shell syntax used to append the completion marker."),
    allowDangerous: z.boolean().default(false).describe("Allow commands that match dangerous patterns."),
    timeoutMs: z.number().int().positive().default(30_000),
  },
  async ({ sessionId, command, waitFor, shellType, allowDangerous, timeoutMs }) => {
    const id = randomUUID();
    const effectiveWaitFor =
      waitFor === "__XSHELL_MCP_DONE__" ? `__XSHELL_MCP_DONE_${id.replace(/-/g, "_")}__` : waitFor;
    const markerCommand = markerForShell(shellType, effectiveWaitFor);
    await appendAudit(sessionId, {
      id,
      tool: "xshell_exec",
      command,
      waitFor: effectiveWaitFor,
      shellType,
      allowDangerous,
      status: "started",
    });

    try {
      assertCommandAllowed(command, allowDangerous);
      const result = await callBridge(
        sessionId,
        { id, op: "exec", command, waitFor: effectiveWaitFor, markerCommand, timeoutMs },
        timeoutMs + 5_000,
      );
      await appendAudit(sessionId, { id, tool: "xshell_exec", status: "completed" });
      return textResult(String(result ?? ""));
    } catch (error) {
      await appendAudit(sessionId, {
        id,
        tool: "xshell_exec",
        status: "failed",
        error: (error as Error).message,
      });
      throw error;
    }
  },
);

await ensureBridgeDirs(defaultSessionId);
const transport = new StdioServerTransport();
await server.connect(transport);
