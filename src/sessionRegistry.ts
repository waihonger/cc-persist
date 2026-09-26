import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// Matches terminalManager's SESSION_ID_RE without importing the VS Code runtime.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PID_JSON_RE = /^\d+\.json$/;

export interface RegistryRow {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  kind: "interactive" | "background";
}

export function resolveSessionsDir(env = process.env, home = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "sessions");
}

/** Validate the internal registry format and keep only interactive sessions. */
export function parseRegistryRow(raw: unknown): RegistryRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 0) return null;
  if (typeof row.sessionId !== "string" || !SESSION_ID_RE.test(row.sessionId)) return null;
  if (row.kind !== undefined && row.kind !== "interactive") return null;

  return {
    pid: row.pid,
    sessionId: row.sessionId,
    kind: "interactive",
    ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
  };
}

function runAgents(): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile uses pipes for stdio and does not invoke a shell.
    execFile(
      "claude",
      ["agents", "--json"],
      { encoding: "utf8", timeout: 5000, shell: false },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function readRegistryFiles(sessionsDir: string): Promise<RegistryRow[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const rows = await Promise.all(files.filter((file) => PID_JSON_RE.test(file)).map(async (file) => {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(path.join(sessionsDir, file), "utf8"));
      return parseRegistryRow(raw);
    } catch {
      // Files may be removed or rewritten while the directory is being read.
      return null;
    }
  }));
  return rows.filter((row): row is RegistryRow => row !== null);
}

export async function readRegistry(opts: {
  sessionsDir?: string;
  runAgents?: () => Promise<string>;
} = {}): Promise<RegistryRow[]> {
  try {
    const output = await (opts.runAgents ?? runAgents)();
    const raw: unknown = JSON.parse(output);
    if (Array.isArray(raw)) {
      const rows = raw.map(parseRegistryRow).filter((row): row is RegistryRow => row !== null);
      if (rows.length > 0) return rows;
    }
  } catch {
    // Missing CLI, command failure, empty output, or invalid JSON: read files.
  }
  return readRegistryFiles(opts.sessionsDir ?? resolveSessionsDir());
}
