import { describe, expect, it } from "vitest";
import {
  findOwningShellPid,
  isClaudeCommand,
  parsePsOutput,
  type ProcEntry,
} from "../src/pidResolver";

function processMap(entries: ProcEntry[]): Map<number, ProcEntry> {
  return new Map(entries.map((entry) => [entry.pid, entry]));
}

describe("PID resolver", () => {
  it("parsePsOutput parses realistic process rows and skips malformed lines", () => {
    const procs = parsePsOutput(`
  PID  PPID COMMAND
  501     1 /bin/zsh -l
  612   501 /usr/bin/env node /usr/local/bin/claude --resume abc def
not a process row
  700 nope claude
  701   501
`);

    expect([...procs.values()]).toEqual([
      { pid: 501, ppid: 1, command: "/bin/zsh -l" },
      { pid: 612, ppid: 501, command: "/usr/bin/env node /usr/local/bin/claude --resume abc def" },
    ]);
  });

  it("isClaudeCommand recognizes Claude CLI invocations only", () => {
    expect(isClaudeCommand("claude --resume x")).toBe(true);
    expect(isClaudeCommand("/usr/local/bin/claude -p")).toBe(true);
    expect(isClaudeCommand("claude")).toBe(true);
    expect(isClaudeCommand("node claude-thing.js")).toBe(false);
    expect(isClaudeCommand("xclaude")).toBe(false);
    expect(isClaudeCommand("claude-monitor --foo")).toBe(false);
  });

  it("resolves a direct shell to Claude child", () => {
    const procs = processMap([
      { pid: 100, ppid: 1, command: "/bin/zsh -l" },
      { pid: 200, ppid: 100, command: "claude --resume x" },
    ]);

    expect(findOwningShellPid(200, procs, new Set([100]))).toBe(100);
  });

  it("resolves through a deep process chain", () => {
    const procs = processMap([
      { pid: 100, ppid: 1, command: "/bin/zsh -l" },
      { pid: 150, ppid: 100, command: "/bin/sh ./launch-claude" },
      { pid: 200, ppid: 150, command: "claude --resume x" },
    ]);

    expect(findOwningShellPid(200, procs, new Set([100]))).toBe(100);
  });

  it("rejects nested Claude while still resolving the outer Claude", () => {
    const procs = processMap([
      { pid: 100, ppid: 1, command: "/bin/zsh -l" },
      { pid: 200, ppid: 100, command: "claude --resume outer" },
      { pid: 250, ppid: 200, command: "/bin/bash" },
      { pid: 300, ppid: 250, command: "claude -p inner" },
    ]);
    const shellPids = new Set([100]);

    expect(findOwningShellPid(300, procs, shellPids)).toBeNull();
    expect(findOwningShellPid(200, procs, shellPids)).toBe(100);
  });

  it("returns null for missing processes, orphaned chains, and ppid cycles", () => {
    const orphaned = processMap([
      { pid: 200, ppid: 150, command: "claude" },
    ]);
    const cyclic = processMap([
      { pid: 200, ppid: 250, command: "claude" },
      { pid: 250, ppid: 200, command: "/bin/bash" },
    ]);

    expect(findOwningShellPid(999, orphaned, new Set([100]))).toBeNull();
    expect(findOwningShellPid(200, orphaned, new Set([100]))).toBeNull();
    expect(findOwningShellPid(200, cyclic, new Set([100]))).toBeNull();
  });
});
