import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { parseSidPayload } from "./terminalManager";
import { snapshotProcesses, type ProcEntry } from "./pidResolver";

const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds
const PID_SID_FILE_RE = /^pid-(\d+)\.sid$/;
const SID_GIVE_UP_MS = 30 * 60 * 1000;

export type PidSessionOutcome = "adopted" | "retry" | "discard";

/** Watches the signal dir for `pid-<pid>.sid` session captures (the persistence lane). */
export class SidWatcher {
  private readonly signalDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly onPidSessionId: (
    claudePid: number,
    sid: string,
    cwd: string | undefined,
    fileMtimeMs: number,
    procs: Promise<Map<number, ProcEntry>>,
  ) => Promise<PidSessionOutcome>;
  private readonly snapshot: () => Promise<Map<number, ProcEntry>>;
  private readonly pidSessionIdsInFlight = new Set<string>();
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private restoreComplete = false;

  constructor(
    signalDir: string,
    log: vscode.OutputChannel,
    onPidSessionId: (
      claudePid: number,
      sid: string,
      cwd: string | undefined,
      fileMtimeMs: number,
      procs: Promise<Map<number, ProcEntry>>,
    ) => Promise<PidSessionOutcome> = async () => "retry",
    snapshot: () => Promise<Map<number, ProcEntry>> = snapshotProcesses,
  ) {
    this.signalDir = signalDir;
    this.log = log;
    this.onPidSessionId = onPidSessionId;
    this.snapshot = snapshot;
  }

  start(): void {
    fs.mkdirSync(this.signalDir, { recursive: true });
    this.scan();
    try {
      this.watcher = fs.watch(this.signalDir, (_, filename) => {
        if (filename) this.onFile(filename);
      });
      this.watcher.on("error", (err) => {
        this.log.appendLine(`Watcher error: ${err.message}`);
      });
    } catch {
      this.log.appendLine("Failed to watch signals directory");
    }
    this.pollTimer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }

  markRestoreComplete(): void {
    this.restoreComplete = true;
    // Full rescan: picks up .sid files deferred while restore was pending
    // (ingesting them earlier would race state loading).
    this.scan();
  }

  private scan(): void {
    if (!this.restoreComplete) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.signalDir);
    } catch {
      return; // dir may not exist yet
    }
    let procs: Promise<Map<number, ProcEntry>> | undefined;
    for (const file of files) {
      const m = PID_SID_FILE_RE.exec(file);
      if (!m) continue;
      procs ??= this.snapshot();
      this.onPidSessionIdFile(file, Number(m[1]), procs);
    }
  }

  private onFile(filename: string): void {
    const m = PID_SID_FILE_RE.exec(filename);
    if (!m || !this.restoreComplete) return;
    this.onPidSessionIdFile(filename, Number(m[1]), this.snapshot());
  }

  private async onPidSessionIdFile(
    filename: string,
    claudePid: number,
    procs: Promise<Map<number, ProcEntry>>,
  ): Promise<void> {
    if (this.pidSessionIdsInFlight.has(filename)) return;
    this.pidSessionIdsInFlight.add(filename);
    const filePath = path.join(this.signalDir, filename);
    try {
      let fileMtimeMs: number;
      try {
        fileMtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        return; // file may have been deleted
      }

      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        return; // file may have been deleted
      }

      let outcome: PidSessionOutcome = "retry";
      const payload = parseSidPayload(raw);
      if (Number.isInteger(claudePid) && claudePid > 0 && payload) {
        try {
          outcome = await this.onPidSessionId(
            claudePid,
            payload.sessionId,
            payload.cwd,
            fileMtimeMs,
            procs,
          );
        } catch {
          outcome = "retry";
        }
      }

      if (outcome === "adopted") {
        this.log.appendLine(`Session ID received: process ${claudePid}`);
      } else if (outcome === "discard") {
        this.log.appendLine(`Discarded session ID file for pid ${claudePid} (not a live Claude process): ${filename}`);
      } else {
        let ageMs = Infinity;
        try {
          ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
        } catch {
          return; // already gone
        }
        if (ageMs <= SID_GIVE_UP_MS) return;
        this.log.appendLine(`Gave up on session ID file after 30 minutes: ${filename}`);
      }

      let currentRaw: string;
      try {
        currentRaw = fs.readFileSync(filePath, "utf8");
      } catch {
        return; // already gone
      }
      if (currentRaw !== raw) {
        this.log.appendLine(`Session ID file superseded while resolving: ${filename}`);
        return;
      }
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone
      }
    } finally {
      this.pidSessionIdsInFlight.delete(filename);
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
