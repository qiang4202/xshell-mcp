export type ShellType = "posix" | "cmd" | "powershell" | "raw";

export const builtinDangerousCommandPatternSources: string[] = [
  "\\brm\\s+(-[^\\s]*[rf][^\\s]*|-r|-f)\\s+",
  "\\bshutdown\\b",
  "\\breboot\\b",
  "\\bpoweroff\\b",
  "\\bhalt\\b",
  "\\bmkfs(?:\\.\\w+)?\\b",
  "\\bdd\\s+.*\\bof\\s*=",
  "\\bchmod\\s+(-[^\\s]*R[^\\s]*\\s+)?777\\b",
  "\\bchown\\s+(-[^\\s]*R[^\\s]*\\s+)",
  // Match the passwd *command*, not the /etc/passwd path used by read-only audits.
  "(?<![\\w./\\\\-])passwd(?![\\w.-])",
  ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:",
];

export function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compilePattern(source: string): RegExp {
  return new RegExp(source, "i");
}

export function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function shellQuotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function markerForShell(shellType: ShellType, marker: string): string {
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

export function sanitizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error("sessionId may only contain letters, numbers, dots, underscores, and hyphens.");
  }
  return trimmed;
}

export function getSessionLiveness(
  status: unknown,
  sessionStaleAfterMs: number,
  now: number = Date.now(),
): { state: "online" | "stale" | "unknown"; ageMs: number | null; staleAfterMs: number } {
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
    return { state: "unknown", ageMs: null, staleAfterMs: sessionStaleAfterMs };
  }

  const ageMs = now - timestamp;
  return {
    state: ageMs <= sessionStaleAfterMs ? "online" : "stale",
    ageMs,
    staleAfterMs: sessionStaleAfterMs,
  };
}

const ANSI_SGR_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC_PATTERN, "").replace(ANSI_SGR_PATTERN, "");
}

export function applyScreenOptions(
  raw: string,
  mode: "full" | "tail",
  tailRows: number,
  stripAnsiFlag: boolean,
): string {
  let text = stripAnsiFlag ? stripAnsi(raw) : raw;
  if (mode === "tail" && tailRows > 0) {
    const lines = text.split(/\r?\n/);
    text = lines.slice(-tailRows).join("\n");
  }
  return text;
}

export function classifyErrorMessage(msg: string): string {
  if (msg.includes("Timed out")) return "timeout";
  if (msg.includes("Blocked potentially dangerous")) return "blocked_command";
  if (msg.includes("Xshell bridge")) return "bridge_error";
  return "internal_error";
}

export function buildDangerousPatterns(config: {
  builtinRulesEnabled?: boolean;
  blockedPatterns?: string[];
  blockedLiterals?: string[];
}): RegExp[] {
  const parts: RegExp[] = [];
  if (config.builtinRulesEnabled !== false) {
    parts.push(...builtinDangerousCommandPatternSources.map(compilePattern));
  }
  parts.push(...(config.blockedPatterns ?? []).map(compilePattern));
  parts.push(...(config.blockedLiterals ?? []).map((l) => compilePattern(escapeRegExp(l))));
  return parts.sort((a, b) => a.source.length - b.source.length);
}

export function isCommandBlocked(patterns: RegExp[], command: string): boolean {
  const compact = command.replace(/\s+/g, " ").trim();
  return patterns.some((p) => p.test(compact));
}

// Some MCP clients serialise arrays as {"item":[...]} or send a JSON string.
// Normalise before validation so callers are not rejected on shape alone.
export function normalizeBatchItems(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input;
  }
  if (typeof input === "string") {
    try {
      return normalizeBatchItems(JSON.parse(input));
    } catch {
      return input;
    }
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["item", "items", "list", "value", "data"]) {
      if (key in record) {
        return normalizeBatchItems(record[key]);
      }
    }
    if ("command" in record) {
      return [record];
    }
  }
  return input;
}

export function formatExecResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    if (typeof value.screen === "string") {
      return value.screen;
    }
    if (typeof value.matched === "string") {
      return `matched: ${value.matched}`;
    }
    if (value.sent === true) {
      return "sent.";
    }
  }
  return String(result ?? "");
}

// Older bridges put the failure reason under result.error, newer ones also set a
// top-level error. Read both so the real reason is never replaced by "unknown error".
export function extractBridgeError(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const record = response as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.length > 0) {
    return record.error;
  }
  const result = record.result;
  if (result && typeof result === "object") {
    const inner = (result as Record<string, unknown>).error;
    if (typeof inner === "string" && inner.length > 0) {
      return inner;
    }
  }
  return undefined;
}

/**
 * Normalise the optional `sessionLabels` config map.
 *
 * Under a bastion/jump host every tab auto-detects the same name, so operators
 * map the stable ids they typed in the interactive launcher to real machines.
 * Malformed entries are dropped instead of failing the whole server.
 */
export function normalizeSessionLabels(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const key = rawKey.trim();
    const label = rawValue.trim();
    if (key && label) {
      out[key] = label;
    }
  }
  return out;
}

/** Read a non-empty string field from a parsed status.json object. */
export function getStatusString(status: unknown, key: string): string | undefined {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return undefined;
  }
  const value = (status as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve the human-readable label for a session.
 *
 * Priority: an explicit config mapping, then a differing `alias` written by the
 * bridge. An alias equal to the id adds no information and is ignored.
 */
export function resolveSessionLabel(
  sessionId: string,
  status: unknown,
  labels: Record<string, string>,
): string | undefined {
  const configured = labels?.[sessionId];
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  const alias = getStatusString(status, "alias");
  if (alias && alias !== sessionId) {
    return alias;
  }
  return undefined;
}

