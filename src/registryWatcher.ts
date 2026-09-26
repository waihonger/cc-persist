import * as fs from "fs";
import type * as vscode from "vscode";
import { snapshotProcesses, type ProcEntry } from "./pidResolver";
import { readRegistry, type RegistryRow } from "./sessionRegistry";

const DEBOUNCE_MS = 300;
const MAX_DEBOUNCE_MS = 2000;
const RETRY_MS = 2000;
const MAX_RETRIES = 3;
const WATCH_RETRY_MS = 30 * 1000;

export type PidSessionOutcome = "adopted" | "retry" | "discard" | "foreign";

type SessionPayload = Pick<RegistryRow, "sessionId" | "cwd">;

function matchesPayload(payload: SessionPayload | undefined, row: RegistryRow): boolean {
  return payload !== undefined && payload.sessionId === row.sessionId && payload.cwd === row.cwd;
}

/** Reads the session registry after restore, without modifying its directory. */
export class RegistryWatcher {
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private maxDebounceTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly adopted = new Map<number, SessionPayload>();
  private readonly foreign = new Map<number, SessionPayload>();
  private readonly inFlight = new Set<number>();
  private readonly attempts = new Map<number, number>();
  private readonly retryPids = new Set<number>();
  private lastStatuses = new Map<number, string | undefined>();
  private started = false;
  private disposed = false;
  private restoreComplete = false;
  private watchFailureLogged = false;
  private reconciling = false;
  private pendingFullScan: boolean | undefined;

  /** Settable callback for status changes between reconciles; never called on first sight. */
  public onStatusChange?: (
    pid: number,
    from: string | undefined,
    to: string | undefined,
    row: RegistryRow,
  ) => void;

  constructor(
    private readonly sessionsDir: string,
    private readonly log: vscode.OutputChannel,
    private readonly onRow: (
      pid: number,
      sessionId: string,
      cwd: string | undefined,
      procs: Promise<Map<number, ProcEntry>>,
      startedAt: number | undefined,
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
      this.watcher = fs.watch(this.sessionsDir, () => this.scheduleReconcile());
      this.watcher.on("error", (error) => this.retryWatch(error));
      this.watchFailureLogged = false;
      void this.reconcile(true);
    } catch (error) {
      this.retryWatch(error);
    }
  }

  private scheduleReconcile(): void {
    if (this.disposed) return;
    // Remember rewrites immediately, even if adoption finishes before debounce fires.
    if (this.reconciling) this.pendingFullScan = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const flush = () => {
      this.clearDebounce();
      void this.reconcile(true);
    };
    this.debounceTimer = setTimeout(flush, DEBOUNCE_MS);
    this.maxDebounceTimer ??= setTimeout(flush, MAX_DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxDebounceTimer) clearTimeout(this.maxDebounceTimer);
    this.debounceTimer = undefined;
    this.maxDebounceTimer = undefined;
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
    this.clearDebounce();
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
      this.updateStatuses(rows);
      if (this.disposed) return;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      const retryPids = new Set(this.retryPids);
      this.retryPids.clear();
      // A new filesystem event gives unresolved rows a fresh retry budget.
      if (fullScan) this.attempts.clear();
      const livePids = new Set(rows.filter((row) => row.kind === "interactive").map((row) => row.pid));
      for (const pid of this.adopted.keys()) {
        if (!livePids.has(pid)) this.adopted.delete(pid);
      }
      for (const pid of this.foreign.keys()) {
        if (!livePids.has(pid)) this.foreign.delete(pid);
      }
      for (const pid of this.attempts.keys()) {
        if (!livePids.has(pid)) this.attempts.delete(pid);
      }
      let procs: Promise<Map<number, ProcEntry>> | undefined;
      const adoptions: Promise<PidSessionOutcome>[] = [];
      for (const row of rows) {
        if (row.kind !== "interactive" || this.inFlight.has(row.pid)) continue;
        const adopted = this.adopted.get(row.pid);
        const foreign = this.foreign.get(row.pid);
        if (matchesPayload(adopted, row) || matchesPayload(foreign, row)) continue;
        const changed = adopted !== undefined || foreign !== undefined;
        if (!fullScan && !retryPids.has(row.pid) && !changed) continue;
        procs ??= Promise.resolve().then(() => this.snapshot());
        adoptions.push(this.adopt(row, procs));
      }
      const outcomes = await Promise.all(adoptions);
      const foreignCount = outcomes.filter((outcome) => outcome === "foreign").length;
      if (!this.disposed && foreignCount > 0) {
        this.log.appendLine(`Skipped ${foreignCount} foreign registry row(s)`);
      }
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
      if (pending !== undefined && !this.disposed) {
        // Re-read after in-flight work, then compare against the payload actually adopted.
        if (pending) this.clearDebounce();
        void this.reconcile(pending);
      }
    }
  }

  private updateStatuses(rows: RegistryRow[]): void {
    const interactiveRows = rows.filter((row) => row.kind === "interactive");
    const previous = this.lastStatuses;
    // Replace the map so vanished PIDs are treated as new if they reappear.
    this.lastStatuses = new Map(interactiveRows.map((row) => [row.pid, row.status]));
    for (const row of interactiveRows) {
      if (this.disposed) return;
      const from = previous.get(row.pid);
      if (!previous.has(row.pid) || from === row.status) continue;
      try {
        this.onStatusChange?.(row.pid, from, row.status, row);
      } catch (error) {
        this.log.appendLine(`Status change callback failed for process ${row.pid}: ${error}`);
      }
    }
  }

  private async adopt(row: RegistryRow, procs: Promise<Map<number, ProcEntry>>): Promise<PidSessionOutcome> {
    this.inFlight.add(row.pid);
    const payload: SessionPayload = { sessionId: row.sessionId, cwd: row.cwd };
    const attempts = (this.attempts.get(row.pid) ?? 0) + 1;
    this.attempts.set(row.pid, attempts);
    let outcome: PidSessionOutcome = "retry";
    try {
      outcome = await this.onRow(row.pid, payload.sessionId, payload.cwd, procs, row.startedAt);
    } catch (error) {
      if (!this.disposed) this.log.appendLine(`Failed to adopt process ${row.pid}: ${error}`);
    } finally {
      this.inFlight.delete(row.pid);
    }
    if (this.disposed) return outcome;
    if (outcome === "adopted") {
      this.adopted.set(row.pid, payload);
      this.foreign.delete(row.pid);
      this.attempts.delete(row.pid);
      this.log.appendLine(`Session ID received: process ${row.pid}`);
    } else if (outcome === "foreign") {
      this.foreign.set(row.pid, payload);
      this.adopted.delete(row.pid);
      this.attempts.delete(row.pid);
    } else if (outcome === "discard") {
      this.attempts.delete(row.pid);
      this.log.appendLine(`Discarded registry row for pid ${row.pid} (not a live Claude process)`);
    } else if (attempts <= MAX_RETRIES) {
      this.retryPids.add(row.pid);
    } else {
      this.log.appendLine(`Gave up adopting process ${row.pid} after ${MAX_RETRIES} retries`);
    }
    return outcome;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.clearDebounce();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pendingFullScan = undefined;
    this.retryPids.clear();
    this.attempts.clear();
    this.adopted.clear();
    this.foreign.clear();
    this.lastStatuses.clear();
  }
}
