import { describe, expect, it } from "vitest";
import {
  applyScreenOptions,
  buildDangerousPatterns,
  classifyErrorMessage,
  escapeRegExp,
  extractBridgeError,
  formatExecResult,
  getSessionLiveness,
  isCommandBlocked,
  markerForShell,
  normalizeBatchItems,
  sanitizeSessionId,
  shellQuotePosix,
  shellQuotePowerShell,
  stripAnsi,
  stripBom,
} from "../src/pure.js";

describe("stripBom", () => {
  it("removes leading BOM", () => {
    expect(stripBom("\uFEFFhello")).toBe("hello");
  });
  it("leaves plain text untouched", () => {
    expect(stripBom("hello")).toBe("hello");
  });
});

describe("escapeRegExp", () => {
  it("escapes special characters", () => {
    expect(escapeRegExp("a.b*c?")).toBe("a\\.b\\*c\\?");
  });
});

describe("shellQuotePosix", () => {
  it("wraps in single quotes", () => {
    expect(shellQuotePosix("abc")).toBe("'abc'");
  });
  it("escapes embedded single quotes", () => {
    expect(shellQuotePosix("a'b")).toBe("'a'\\''b'");
  });
});

describe("shellQuotePowerShell", () => {
  it("escapes single quotes by doubling", () => {
    expect(shellQuotePowerShell("a'b")).toBe("'a''b'");
  });
});

describe("markerForShell", () => {
  it("generates posix echo", () => {
    expect(markerForShell("posix", "DONE")).toBe("echo 'DONE'");
  });
  it("generates powershell Write-Output", () => {
    expect(markerForShell("powershell", "DONE")).toBe("Write-Output 'DONE'");
  });
  it("generates cmd echo without quoting", () => {
    expect(markerForShell("cmd", "DONE")).toBe("echo DONE");
  });
  it("returns empty string for raw", () => {
    expect(markerForShell("raw", "DONE")).toBe("");
  });
});

describe("sanitizeSessionId", () => {
  it("accepts alphanumerics and separators", () => {
    expect(sanitizeSessionId("server-01.prod")).toBe("server-01.prod");
  });
  it("rejects empty / invalid", () => {
    expect(() => sanitizeSessionId("")).toThrow();
    expect(() => sanitizeSessionId("a/b")).toThrow();
  });
});

describe("getSessionLiveness", () => {
  const staleMs = 30_000;
  const now = new Date("2026-09-21T12:00:00Z").getTime();

  it("returns unknown when status has no timestamp", () => {
    const r = getSessionLiveness({}, staleMs, now);
    expect(r.state).toBe("unknown");
  });

  it("returns online when lastSeenAt is fresh", () => {
    const recent = new Date(now - 5_000).toISOString();
    const r = getSessionLiveness({ lastSeenAt: recent }, staleMs, now);
    expect(r.state).toBe("online");
    expect(r.ageMs).toBe(5_000);
  });

  it("returns stale when lastSeenAt is too old", () => {
    const old = new Date(now - 60_000).toISOString();
    const r = getSessionLiveness({ lastSeenAt: old }, staleMs, now);
    expect(r.state).toBe("stale");
  });
});

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });
  it("removes OSC sequences", () => {
    expect(stripAnsi("\u001b]0;title\u0007body")).toBe("body");
  });
  it("keeps regular text intact", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("applyScreenOptions", () => {
  const sample = "row1\nrow2\nrow3\nrow4\nrow5";

  it("returns full text by default", () => {
    expect(applyScreenOptions(sample, "full", 30, true)).toBe(sample);
  });

  it("keeps last N rows when tail mode", () => {
    expect(applyScreenOptions(sample, "tail", 2, true)).toBe("row4\nrow5");
  });

  it("strips ANSI when enabled", () => {
    const ansi = "\u001b[31mred\u001b[0m\nplain";
    expect(applyScreenOptions(ansi, "full", 30, true)).toBe("red\nplain");
  });
});

describe("classifyErrorMessage", () => {
  it("detects timeout", () => {
    expect(classifyErrorMessage("Timed out after 30s")).toBe("timeout");
  });
  it("detects blocked command", () => {
    expect(classifyErrorMessage("Blocked potentially dangerous command.")).toBe("blocked_command");
  });
  it("detects bridge error", () => {
    expect(classifyErrorMessage("Xshell bridge returned an unknown error.")).toBe("bridge_error");
  });
  it("falls back to internal_error", () => {
    expect(classifyErrorMessage("anything else")).toBe("internal_error");
  });
});

describe("buildDangerousPatterns + isCommandBlocked", () => {
  const patterns = buildDangerousPatterns({
    builtinRulesEnabled: true,
    blockedLiterals: ["format c:"],
  });

  it("blocks rm -rf", () => {
    expect(isCommandBlocked(patterns, "rm -rf /tmp")).toBe(true);
  });

  it("blocks shutdown", () => {
    expect(isCommandBlocked(patterns, "shutdown -h now")).toBe(true);
  });

  it("blocks literal", () => {
    expect(isCommandBlocked(patterns, "format c:")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(isCommandBlocked(patterns, "ls -la")).toBe(false);
  });

  it("skips builtin rules when disabled", () => {
    const customOnly = buildDangerousPatterns({
      builtinRulesEnabled: false,
      blockedLiterals: ["custom-block"],
    });
    expect(isCommandBlocked(customOnly, "rm -rf /")).toBe(false);
    expect(isCommandBlocked(customOnly, "custom-block")).toBe(true);
  });

  it("blocks the passwd command", () => {
    expect(isCommandBlocked(patterns, "passwd")).toBe(true);
    expect(isCommandBlocked(patterns, "passwd someuser")).toBe(true);
    expect(isCommandBlocked(patterns, "sudo passwd root")).toBe(true);
    expect(isCommandBlocked(patterns, "id; passwd")).toBe(true);
  });

  it("does not block read-only /etc/passwd access", () => {
    expect(isCommandBlocked(patterns, "awk -F: '($3==0){print $1}' /etc/passwd")).toBe(false);
    expect(isCommandBlocked(patterns, "cat /etc/passwd")).toBe(false);
    expect(isCommandBlocked(patterns, "grep root /etc/passwd")).toBe(false);
  });

  it("does not block read-only /etc/shadow access", () => {
    expect(isCommandBlocked(patterns, `awk -F: '($2==""){print $1}' /etc/shadow`)).toBe(false);
  });
});

describe("normalizeBatchItems", () => {
  const item = { command: "ls" };

  it("passes through a plain array", () => {
    expect(normalizeBatchItems([item])).toEqual([item]);
  });

  it("unwraps {item: [...]} produced by some clients", () => {
    expect(normalizeBatchItems({ item: [item] })).toEqual([item]);
  });

  it("unwraps {items: [...]}", () => {
    expect(normalizeBatchItems({ items: [item] })).toEqual([item]);
  });

  it("parses a JSON string", () => {
    expect(normalizeBatchItems('[{"command":"ls"}]')).toEqual([item]);
  });

  it("parses a JSON string wrapped in an object", () => {
    expect(normalizeBatchItems('{"item":[{"command":"ls"}]}')).toEqual([item]);
  });

  it("wraps a single command object", () => {
    expect(normalizeBatchItems(item)).toEqual([item]);
  });

  it("leaves unusable input untouched so validation still fails", () => {
    expect(normalizeBatchItems(42)).toBe(42);
    expect(normalizeBatchItems("not json")).toBe("not json");
  });
});

describe("formatExecResult", () => {
  it("returns the screen when present", () => {
    expect(formatExecResult({ matched: "DONE", screen: "line1\nline2" })).toBe("line1\nline2");
  });

  it("falls back to the matched marker", () => {
    expect(formatExecResult({ matched: "DONE" })).toBe("matched: DONE");
  });

  it("reports sent", () => {
    expect(formatExecResult({ sent: true })).toBe("sent.");
  });

  it("passes through strings", () => {
    expect(formatExecResult("raw")).toBe("raw");
  });
});

describe("extractBridgeError", () => {
  it("reads a top-level error", () => {
    expect(extractBridgeError({ ok: false, error: "boom" })).toBe("boom");
  });

  it("falls back to result.error from older bridges", () => {
    expect(extractBridgeError({ ok: false, result: { error: "older shape" } })).toBe("older shape");
  });

  it("prefers the top-level error", () => {
    expect(extractBridgeError({ ok: false, error: "top", result: { error: "inner" } })).toBe("top");
  });

  it("returns undefined when there is no error", () => {
    expect(extractBridgeError({ ok: true, result: { matched: "x" } })).toBeUndefined();
    expect(extractBridgeError(null)).toBeUndefined();
    expect(extractBridgeError("nope")).toBeUndefined();
  });

  it("ignores empty error strings", () => {
    expect(extractBridgeError({ ok: false, error: "" })).toBeUndefined();
  });
});
