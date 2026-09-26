import * as fs from "fs";
import type * as vscode from "vscode";
import { snapshotProcesses, type ProcEntry } from "./pidResolver";
import { readRegistry, type RegistryRow } from "./sessionRegistry";

const DEBOUNCE_MS = 300;
const RETRY_MS = 2000;
const MAX_RETRIES = 3;
const WATCH_RETRY_MS = 30 * 1000;

export type PidSessionOutcome = "adopted" | "retry" | "discard";

/** Reads the session registry after restore, without modifying its directory. */
export class RegistryWatcher {
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly adopted = new Set<number>();
  private readonly inFlight = new Set<number>();
  private readonly attempts = new Map<number, number>();
  private readonly retryPids = new Set<number>();
  private started = false;
  private disposed = false;
  private restoreComplete = false;
  private watchFailureLogged = false;
  private reconciling = false;
  private pendingFullScan: boolean | undefined;

  constructor(
    private readonly sessionsDir: string,
    private readonly log: vscode.OutputChannel,
    private readonly onRow: (
      pid: number,
      sessionId: string,
      cwd: string | undefined,
      procs: Promise<Map<number, ProcEntry>>,
    ) => Promise<PidSessionOutcome>,
    private readonly read: typeof readRegistry = readRegistry,
    private readonly snapshot: () => Promise<Map<number, ProcEntry>> = snapshotProcesses,
  ) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.watch();
  }

  private watch(): void {
    if (this.disposed) return;
    try {
      this.watcher = fs.watch(this.sessionsDir, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          void this.reconcile(true);
        }, DEBOUNCE_MS);
      });
      this.watcher.on("error", (error) => this.retryWatch(error));
      this.watchFailureLogged = false;
      void this.reconcile(true);
    } catch (error) {
      this.retryWatch(error);
    }
  }

  private retryWatch(error: unknown): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.disposed || this.watchTimer) return;
    if (!this.watchFailureLogged) {
      this.log.appendLine(`Cannot watch session registry; retrying in 30 seconds: ${error}`);
      this.watchFailureLogged = true;
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.watch();
    }, WATCH_RETRY_MS);
  }

  markRestoreComplete(): void {
    if (this.restoreComplete || this.disposed) return;
    this.restoreComplete = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    void this.reconcile(true);
  }

  private async reconcile(fullScan: boolean): Promise<void> {
    if (this.disposed || !this.restoreComplete) return;
    if (this.reconciling) {
      this.pendingFullScan = this.pendingFullScan === true || fullScan;
      return;
    }
    this.reconciling = true;
    try {
      const rows = await this.read({ sessionsDir: this.sessionsDir });
      if (this.disposed) return;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      const retryPids = new Set(this.retryPids);
      this.retryPids.clear();
      // A new filesystem event gives unresolved rows a fresh retry budget.
      if (fullScan) this.attempts.clear();
      const livePids = new Set(rows.map((row) => row.pid));
      for (const pid of this.adopted) {
        if (!livePids.has(pid)) this.adopted.delete(pid);
      }
      for (const pid of this.attempts.keys()) {
        if (!livePids.has(pid)) this.attempts.delete(pid);
      }
      let procs: Promise<Map<number, ProcEntry>> | undefined;
      const adoptions: Promise<void>[] = [];
      for (const row of rows) {
        if (row.kind !== "interactive" || this.adopted.has(row.pid) || this.inFlight.has(row.pid)) continue;
        if (!fullScan && !retryPids.has(row.pid)) continue;
        procs ??= Promise.resolve().then(() => this.snapshot());
        adoptions.push(this.adopt(row, procs));
      }
      await Promise.all(adoptions);
      if (!this.disposed && this.retryPids.size > 0) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.reconcile(false);
        }, RETRY_MS);
      }
    } catch (error) {
      if (!this.disposed) this.log.appendLine(`Failed to read session registry: ${error}`);
    } finally {
      this.reconciling = false;
      const pending = this.pendingFullScan;
      this.pendingFullScan = undefined;
      if (pending !== undefined && !this.disposed) void this.reconcile(pending);
    }
  }

  private async adopt(row: RegistryRow, procs: Promise<Map<number, ProcEntry>>): Promise<void> {
    this.inFlight.add(row.pid);
    const attempts = (this.attempts.get(row.pid) ?? 0) + 1;
    this.attempts.set(row.pid, attempts);
    let outcome: PidSessionOutcome = "retry";
    try {
      outcome = await this.onRow(row.pid, row.sessionId, row.cwd, procs);
    } catch (error) {
      if (!this.disposed) this.log.appendLine(`Failed to adopt process ${row.pid}: ${error}`);
    } finally {
      this.inFlight.delete(row.pid);
    }
    if (this.disposed) return;
    if (outcome === "adopted") {
      this.adopted.add(row.pid);
      this.attempts.delete(row.pid);
      this.log.appendLine(`Session ID received: process ${row.pid}`);
    } else if (outcome === "discard") {
      this.attempts.delete(row.pid);
      this.log.appendLine(`Discarded registry row for pid ${row.pid} (not a live Claude process)`);
    } else if (attempts <= MAX_RETRIES) {
      this.retryPids.add(row.pid);
    } else {
      this.log.appendLine(`Gave up adopting process ${row.pid} after ${MAX_RETRIES} retries`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pendingFullScan = undefined;
    this.retryPids.clear();
    this.attempts.clear();
    this.adopted.clear();
  }
}
