import { execFile } from "child_process";

export interface ProcEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -axo pid,ppid,command` output. Skip header + malformed lines. */
export function parsePsOutput(out: string): Map<number, ProcEntry> {
  const procs = new Map<number, ProcEntry>();
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    procs.set(pid, { pid, ppid, command: match[3] });
  }
  return procs;
}

/** True when the command string is a claude CLI invocation. */
export function isClaudeCommand(command: string): boolean {
  return /(^|\/)claude(\s|$)/.test(command);
}

/** Find the terminal shell that owns a Claude process, rejecting nested Claude sessions. */
export function findOwningShellPid(
  claudePid: number,
  procs: Map<number, ProcEntry>,
  shellPids: Set<number>,
): number | null {
  if (claudePid <= 1) return null;
  let current = procs.get(claudePid);
  if (!current) return null;

  const visited = new Set<number>([claudePid]);
  for (let depth = 1; depth <= 32; depth++) {
    const parentPid = current.ppid;
    if (parentPid <= 1 || visited.has(parentPid)) return null;
    if (shellPids.has(parentPid)) return parentPid;

    const parent = procs.get(parentPid);
    if (!parent || isClaudeCommand(parent.command)) return null;
    visited.add(parentPid);
    current = parent;
  }
  return null;
}

/** Snapshot the process table without invoking a shell. */
export function snapshotProcesses(): Promise<Map<number, ProcEntry>> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid,ppid,command"],
      { encoding: "utf8" },
      (error, stdout) => resolve(error ? new Map() : parsePsOutput(stdout)),
    );
  });
}
