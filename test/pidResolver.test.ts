import { describe, expect, it, vi } from "vitest";
import {
  findOwningShellPid,
  isClaudeCommand,
  isLiveClaudePid,
  parsePsOutput,
  type ProcEntry,
} from "../src/pidResolver";

type ProcFixture = Omit<ProcEntry, "startedAtMs"> & { startedAtMs?: number | null };

function processMap(entries: ProcFixture[]): Map<number, ProcEntry> {
  return new Map(entries.map((entry) => [entry.pid, { startedAtMs: null, ...entry }]));
}

describe("PID resolver", () => {
  it("parsePsOutput parses realistic process rows and skips malformed lines", () => {
    const now = 2_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const procs = parsePsOutput(`
  PID  PPID     ELAPSED COMMAND
  501     1       01:23 /bin/zsh -l
  612   501     1:02:03 /usr/bin/env node /usr/local/bin/claude --resume abc def
  700   501  2-03:04:05 claude --resume old
  701   501        nope claude --resume unknown
not a process row
  702 nope       01:00 claude
  703   501       01:00
`);
    nowSpy.mockRestore();

    expect([...procs.values()]).toEqual([
      { pid: 501, ppid: 1, startedAtMs: now - 83_000, command: "/bin/zsh -l" },
      { pid: 612, ppid: 501, startedAtMs: now - 3_723_000, command: "/usr/bin/env node /usr/local/bin/claude --resume abc def" },
      { pid: 700, ppid: 501, startedAtMs: now - 183_845_000, command: "claude --resume old" },
      { pid: 701, ppid: 501, startedAtMs: null, command: "claude --resume unknown" },
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

  it("isLiveClaudePid accepts only a present Claude process above pid 1", () => {
    const procs = processMap([
      { pid: 200, ppid: 100, command: "claude --resume x" },
      { pid: 300, ppid: 100, command: "/bin/bash ./worker" },
    ]);

    expect(isLiveClaudePid(200, procs)).toBe(true);
    expect(isLiveClaudePid(300, procs)).toBe(false);
    expect(isLiveClaudePid(999, procs)).toBe(false);
  });

  it("isLiveClaudePid rejects a PID reused after the capture file was written", () => {
    const writtenAt = 1_000_000;
    const procs = processMap([
      { pid: 200, ppid: 100, startedAtMs: writtenAt + 2_001, command: "claude" },
      { pid: 201, ppid: 100, startedAtMs: writtenAt + 2_000, command: "claude" },
      { pid: 202, ppid: 100, startedAtMs: null, command: "claude" },
    ]);

    expect(isLiveClaudePid(200, procs, writtenAt)).toBe(false);
    expect(isLiveClaudePid(201, procs, writtenAt)).toBe(true);
    expect(isLiveClaudePid(202, procs, writtenAt)).toBe(true);
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

  it("rejects a start PID whose command is not Claude", () => {
    const procs = processMap([
      { pid: 100, ppid: 1, command: "/bin/zsh -l" },
      { pid: 200, ppid: 100, command: "/bin/bash ./worker" },
    ]);

    expect(findOwningShellPid(200, procs, new Set([100]))).toBeNull();
  });

  it("resolves an exec-Claude terminal to the Claude PID itself", () => {
    const procs = processMap([
      { pid: 200, ppid: 1, command: "claude --resume x" },
    ]);

    expect(findOwningShellPid(200, procs, new Set([200]))).toBe(200);
  });

  it("rejects an inner Claude when its shell PID is itself Claude", () => {
    const procs = processMap([
      { pid: 200, ppid: 1, command: "claude --resume outer" },
      { pid: 250, ppid: 200, command: "/bin/bash" },
      { pid: 300, ppid: 250, command: "claude -p inner" },
    ]);

    expect(findOwningShellPid(300, procs, new Set([200]))).toBeNull();
  });
});
