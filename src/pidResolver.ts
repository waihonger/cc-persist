import { execFile } from "child_process";

export interface ProcEntry {
  pid: number;
  ppid: number;
  startedAtMs: number | null;
  command: string;
}

function parseEtimeMs(etime: string): number | null {
  const dayMatch = /^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/.exec(etime);
  const timeMatch = /^(?:(\d+):)?(\d{2}):(\d{2})$/.exec(etime);
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  const hours = Number(dayMatch?.[2] ?? timeMatch?.[1] ?? 0);
  const minutes = Number(dayMatch?.[3] ?? timeMatch?.[2]);
  const seconds = Number(dayMatch?.[4] ?? timeMatch?.[3]);
  if ((!dayMatch && !timeMatch)
    || !Number.isSafeInteger(days)
    || !Number.isSafeInteger(hours)
    || !Number.isSafeInteger(minutes)
    || !Number.isSafeInteger(seconds)
    || (dayMatch !== null && hours > 23)
    || minutes > 59
    || seconds > 59) return null;
  const elapsedMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return Number.isSafeInteger(elapsedMs) ? elapsedMs : null;
}

/** Parse `ps -axo pid,ppid,etime,command` output. Skip header + malformed lines. */
export function parsePsOutput(out: string): Map<number, ProcEntry> {
  const procs = new Map<number, ProcEntry>();
  const now = Date.now();
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const elapsedMs = parseEtimeMs(match[3]);
    procs.set(pid, {
      pid,
      ppid,
      startedAtMs: elapsedMs === null ? null : now - elapsedMs,
      command: match[4],
    });
  }
  return procs;
}

/** True when the command string is a claude CLI invocation. */
export function isClaudeCommand(command: string): boolean {
  return /(^|\/)claude(\s|$)/.test(command);
}

/** True when the PID belongs to the Claude process that wrote the capture file. */
export function isLiveClaudePid(
  pid: number,
  procs: Map<number, ProcEntry>,
  notAfterMs?: number,
): boolean {
  const process = procs.get(pid);
  return pid > 1
    && process !== undefined
    && isClaudeCommand(process.command)
    && !(notAfterMs !== undefined
      && process.startedAtMs !== null
      && process.startedAtMs > notAfterMs + 2000);
}

/** Find the terminal shell that owns a Claude process, rejecting nested Claude sessions. */
export function findOwningShellPid(
  claudePid: number,
  procs: Map<number, ProcEntry>,
  shellPids: Set<number>,
): number | null {
  const start = procs.get(claudePid);
  if (claudePid <= 1 || !start || !isClaudeCommand(start.command)) return null;
  if (shellPids.has(claudePid)) return claudePid;

  const visited = new Set<number>([claudePid]);
  let current = start;
  for (let depth = 0; depth < 32; depth++) {
    const parentPid = current.ppid;
    if (parentPid <= 1 || visited.has(parentPid)) return null;

    const parent = procs.get(parentPid);
    if (parent && isClaudeCommand(parent.command)) return null;
    if (shellPids.has(parentPid)) return parentPid;
    if (!parent) return null;
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
      ["-axo", "pid,ppid,etime,command"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? new Map() : parsePsOutput(stdout)),
    );
  });
}
