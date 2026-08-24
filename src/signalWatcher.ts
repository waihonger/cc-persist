import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { isValidIndex, isValidSessionId } from "./terminalManager";
import type { TerminalManager } from "./terminalManager";

const DEFAULT_STALE_THRESHOLD_HOURS = 4;
const POLL_INTERVAL_MS = 10 * 1000; // 10 seconds
const PID_SID_FILE_RE = /^pid-(\d+)\.sid$/;
const SID_FILE_RE = /^(\d+)\.sid$/;
/** Grace period for a .sid file whose content is still invalid (writer mid-write). */
const SID_RETRY_WINDOW_MS = 60 * 1000;

const SIGNAL_TYPES = [".signal", ".permission", ".error"] as const;
type SignalType = "complete" | "permission" | "error";

function fileExtToType(ext: string): SignalType | null {
  if (ext === ".signal") return "complete";
  if (ext === ".permission") return "permission";
  if (ext === ".error") return "error";
  return null;
}

function typeToExt(type: SignalType): string {
  if (type === "complete") return ".signal";
  if (type === "permission") return ".permission";
  return ".error";
}

interface Signal {
  index: number;
  timestamp: number;
  type: SignalType;
}

export class SignalWatcher {
  private readonly signalDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly terminalManager: TerminalManager;
  /** Returns true when the sid was persisted — false keeps the .sid file for retry. */
  private readonly onSessionId: (index: number, sid: string) => boolean;
  private readonly onPidSessionId: (claudePid: number, sid: string) => Promise<boolean>;
  private readonly staleThresholdMs: number;
  private readonly signals = new Map<string, Signal>(); // key: "index:type"
  private readonly pidSessionIdsInFlight = new Set<string>();
  private readonly statusBarItem: vscode.StatusBarItem;
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private restoreComplete = false;

  constructor(
    signalDir: string,
    terminalManager: TerminalManager,
    log: vscode.OutputChannel,
    onSessionId: (index: number, sid: string) => boolean = () => false,
    staleSignalHours = DEFAULT_STALE_THRESHOLD_HOURS,
    onPidSessionId: (claudePid: number, sid: string) => Promise<boolean> = async () => false,
  ) {
    this.signalDir = signalDir;
    this.terminalManager = terminalManager;
    this.log = log;
    this.onSessionId = onSessionId;
    this.onPidSessionId = onPidSessionId;
    const staleHours = Number.isFinite(staleSignalHours) && staleSignalHours > 0
      ? staleSignalHours
      : DEFAULT_STALE_THRESHOLD_HOURS;
    this.staleThresholdMs = staleHours * 60 * 60 * 1000;

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = "cc-persist.cycleSignal";
    this.updateStatusBar();
  }

  private signalKey(index: number, type: SignalType): string {
    return `${index}:${type}`;
  }

  start(context: vscode.ExtensionContext): void {
    fs.mkdirSync(this.signalDir, { recursive: true });

    // Register command before scanning so status bar clicks work immediately
    context.subscriptions.push(
      vscode.commands.registerCommand("cc-persist.cycleSignal", () => {
        this.cycleToNext();
      }),
    );

    this.scanSignals();

    try {
      this.watcher = fs.watch(this.signalDir, (_, filename) => {
        if (filename === "goto") {
          this.onGotoFile();
        } else if (filename) {
          this.onFile(filename);
        }
      });
      this.watcher.on("error", (err) => {
        this.log.appendLine(`Watcher error: ${err.message}`);
      });
    } catch {
      this.log.appendLine("Failed to watch signals directory");
    }

    this.pollTimer = setInterval(() => this.scanSignals(), POLL_INTERVAL_MS);

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) return;
        this.clearActiveTerminalSignals(terminal);
      }),
    );

    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) return;
        const terminal = vscode.window.activeTerminal;
        if (terminal) this.clearActiveTerminalSignals(terminal);
      }),
    );
  }

  private clearActiveTerminalSignals(terminal: vscode.Terminal): void {
    const index = this.terminalManager.getIndex(terminal);
    if (index === undefined) return;
    let changed = false;
    for (const type of ["complete", "permission", "error"] as SignalType[]) {
      const key = this.signalKey(index, type);
      if (this.signals.has(key)) {
        this.clearSignal(index, type);
        changed = true;
      }
    }
    if (changed) this.updateStatusBar();
  }

  markRestoreComplete(): void {
    this.restoreComplete = true;
    // Full rescan: picks up goto plus any .sid files that were deferred while
    // restore was pending (ingesting them earlier would race state loading).
    this.scanSignals();
  }

  onTerminalClosed(index: number): void {
    for (const type of ["complete", "permission", "error"] as SignalType[]) {
      this.clearSignal(index, type);
    }
    this.updateStatusBar();
  }

  private onGotoFile(): void {
    if (!this.restoreComplete) return;
    const gotoPath = path.join(this.signalDir, "goto");
    try {
      const content = fs.readFileSync(gotoPath, "utf8").trim();
      const index = parseInt(content, 10);
      if (isValidIndex(index)) {
        this.log.appendLine(`Goto request for terminal ${index}`);
        this.terminalManager.showTerminal(index);
        for (const type of ["complete", "permission", "error"] as SignalType[]) {
          this.clearSignal(index, type);
        }
      }
      fs.unlinkSync(gotoPath);
    } catch {
      // file may have been deleted
    }
    this.updateStatusBar();
  }

  private scanSignals(): void {
    try {
      const files = fs.readdirSync(this.signalDir);

      if (this.restoreComplete && files.includes("goto")) {
        this.onGotoFile();
      }

      const keysOnDisk = new Set<string>();

      for (const file of files) {
        if (PID_SID_FILE_RE.test(file)) {
          if (this.restoreComplete) this.onFile(file);
          continue;
        }
        if (SID_FILE_RE.test(file)) {
          if (this.restoreComplete) this.onFile(file);
          continue;
        }
        for (const ext of SIGNAL_TYPES) {
          if (file.endsWith(ext)) {
            const index = parseInt(path.basename(file, ext), 10);
            const type = fileExtToType(ext);
            if (isValidIndex(index) && type) {
              const key = this.signalKey(index, type);
              keysOnDisk.add(key);
              const existing = this.signals.get(key);
              if (existing) {
                // Refresh mtime to avoid premature stale pruning
                try {
                  existing.timestamp = fs.statSync(path.join(this.signalDir, file)).mtimeMs;
                } catch { /* already gone */ }
              } else {
                this.onFile(file);
              }
            }
            break;
          }
        }
      }

      // Prune phantom entries
      for (const key of this.signals.keys()) {
        if (!keysOnDisk.has(key)) {
          this.signals.delete(key);
          this.log.appendLine(`Pruned phantom signal: ${key}`);
        }
      }

      this.updateStatusBar();
    } catch {
      // dir may not exist yet
    }
  }

  private onFile(filename: string): void {
    const pidSidMatch = PID_SID_FILE_RE.exec(filename);
    if (pidSidMatch) {
      if (this.restoreComplete) this.onPidSessionIdFile(filename, Number(pidSidMatch[1]));
      return;
    }

    const sidMatch = SID_FILE_RE.exec(filename);
    if (sidMatch) {
      // Deferred until restore completes — ingesting earlier would persist state
      // before the terminal maps are populated, wiping saved sessions.
      if (this.restoreComplete) this.onSessionIdFile(filename, Number(sidMatch[1]));
      return;
    }

    let signalType: SignalType | null = null;
    let ext = "";
    for (const e of SIGNAL_TYPES) {
      if (filename.endsWith(e)) {
        signalType = fileExtToType(e);
        ext = e;
        break;
      }
    }
    if (!signalType) return;

    const index = parseInt(path.basename(filename, ext), 10);
    if (!isValidIndex(index)) return;

    const filePath = path.join(this.signalDir, filename);
    let timestamp: number;
    try {
      timestamp = fs.statSync(filePath).mtimeMs;
    } catch {
      return;
    }

    if (Date.now() - timestamp > this.staleThresholdMs) {
      this.deleteFile(index, signalType);
      return;
    }

    if (vscode.window.state.focused) {
      const activeTerminal = vscode.window.activeTerminal;
      if (activeTerminal) {
        const activeIndex = this.terminalManager.getIndex(activeTerminal);
        if (activeIndex === index) {
          this.deleteFile(index, signalType);
          return;
        }
      }
    }

    const key = this.signalKey(index, signalType);
    this.signals.set(key, { index, timestamp, type: signalType });
    this.log.appendLine(`Signal received: terminal ${index} (${signalType})`);
    this.updateStatusBar();
  }

  private onSessionIdFile(filename: string, index: number): void {
    const filePath = path.join(this.signalDir, filename);
    let done = false;
    try {
      const sid = fs.readFileSync(filePath, "utf8").trim();
      if (isValidIndex(index) && isValidSessionId(sid)) {
        done = this.onSessionId(index, sid);
        if (done) this.log.appendLine(`Session ID received: terminal ${index}`);
      }
    } catch {
      return; // file may have been deleted
    }
    if (!done) {
      // Not ingested yet: either the writer is mid-write (the hook's `>` truncates
      // before writing, so a fresh file can be empty/partial), the index isn't
      // tracked, or the state save failed. Leave the file so the next poll retries
      // — unlinking now would lose the UUID for good. Clean up only once it has
      // sat unprocessed past the retry window.
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
      } catch {
        return; // already gone
      }
      if (ageMs < SID_RETRY_WINDOW_MS) return;
      this.log.appendLine(`Unprocessed session ID file discarded: ${filename}`);
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone
    }
  }

  private async onPidSessionIdFile(filename: string, claudePid: number): Promise<void> {
    if (this.pidSessionIdsInFlight.has(filename)) return;
    this.pidSessionIdsInFlight.add(filename);
    const filePath = path.join(this.signalDir, filename);
    try {
      let sid: string;
      try {
        sid = fs.readFileSync(filePath, "utf8").trim();
      } catch {
        return; // file may have been deleted
      }

      let done = false;
      if (Number.isInteger(claudePid) && claudePid > 0 && isValidSessionId(sid)) {
        try {
          done = await this.onPidSessionId(claudePid, sid);
        } catch {
          done = false;
        }
        if (done) this.log.appendLine(`Session ID received: process ${claudePid}`);
      }

      if (!done) {
        let ageMs = Infinity;
        try {
          ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
        } catch {
          return; // already gone
        }
        if (ageMs < SID_RETRY_WINDOW_MS) return;
        this.log.appendLine(`Unprocessed session ID file discarded: ${filename}`);
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

  private clearSignal(index: number, type: SignalType): void {
    this.signals.delete(this.signalKey(index, type));
    this.deleteFile(index, type);
  }

  deleteSignalFile(index: number): void {
    for (const type of ["complete", "permission", "error"] as SignalType[]) {
      this.deleteFile(index, type);
    }
  }

  private deleteFile(index: number, type: SignalType): void {
    try {
      fs.unlinkSync(path.join(this.signalDir, `${index}${typeToExt(type)}`));
    } catch {
      // already gone
    }
  }

  private updateStatusBar(): void {
    const now = Date.now();
    const stale: string[] = [];
    for (const [key, signal] of this.signals) {
      if (now - signal.timestamp > this.staleThresholdMs) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      const signal = this.signals.get(key)!;
      this.clearSignal(signal.index, signal.type);
    }

    const count = this.signals.size;
    if (count === 0) {
      this.statusBarItem.hide();
      return;
    }

    // Check for urgent signals (permission/error)
    const hasUrgent = [...this.signals.values()].some(
      (s) => s.type === "permission" || s.type === "error",
    );

    const icon = hasUrgent ? "$(alert)" : "$(bell)";
    this.statusBarItem.text = `${icon} ${count} awaiting`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      hasUrgent ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground",
    );
    this.statusBarItem.tooltip = this.buildTooltip();
    this.statusBarItem.show();
  }

  private buildTooltip(): string {
    const lines = ["Terminals awaiting attention:"];
    const now = Date.now();
    const sorted = [...this.signals.values()].sort((a, b) => {
      // Urgent first, then by timestamp
      const urgencyA = a.type === "permission" ? 0 : a.type === "error" ? 1 : 2;
      const urgencyB = b.type === "permission" ? 0 : b.type === "error" ? 1 : 2;
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
      return b.timestamp - a.timestamp;
    });
    for (const signal of sorted) {
      const ago = Math.round((now - signal.timestamp) / 60000);
      const name = this.terminalManager.getSavedName(signal.index) || `Terminal ${signal.index + 1}`;
      const icon = signal.type === "permission" ? "🔴" : signal.type === "error" ? "❌" : "●";
      const label = signal.type === "permission" ? "needs approval" : signal.type === "error" ? "error" : "done";
      lines.push(`  ${icon} ${name} — ${label} (${ago}m ago)`);
    }
    return lines.join("\n");
  }

  private cycleToNext(): void {
    if (this.signals.size === 0) return;

    // Jump straight to the highest priority signal — no dropdown
    const sorted = [...this.signals.values()].sort((a, b) => {
      const urgencyA = a.type === "permission" ? 0 : a.type === "error" ? 1 : 2;
      const urgencyB = b.type === "permission" ? 0 : b.type === "error" ? 1 : 2;
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
      return b.timestamp - a.timestamp;
    });

    const signal = sorted[0];
    this.terminalManager.showTerminal(signal.index);
    this.clearSignal(signal.index, signal.type);
    this.updateStatusBar();
  }

  /* kept for reference — unused
  private async _cycleToNextWithPicker(): Promise<void> {
    if (this.signals.size === 0) return;

    const now = Date.now();
    const items = [...this.signals.values()]
      .sort((a, b) => {
        const urgencyA = a.type === "permission" ? 0 : a.type === "error" ? 1 : 2;
        const urgencyB = b.type === "permission" ? 0 : b.type === "error" ? 1 : 2;
        if (urgencyA !== urgencyB) return urgencyA - urgencyB;
        return b.timestamp - a.timestamp;
      })
      .map((signal) => {
        const ago = Math.round((now - signal.timestamp) / 60000);
        const name = this.terminalManager.getSavedName(signal.index) || `Terminal ${signal.index + 1}`;
        const icon = signal.type === "permission" ? "$(alert)" : signal.type === "error" ? "$(error)" : "$(bell)";
        const label = signal.type === "permission" ? "needs approval" : signal.type === "error" ? "error" : "done";
        return { label: `${icon} ${name}`, description: `${label} — ${ago}m ago`, signal };
      });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select terminal to switch to (urgent first)",
    });

    if (picked) {
      this.terminalManager.showTerminal(picked.signal.index);
      this.clearSignal(picked.signal.index, picked.signal.type);
      this.updateStatusBar();
    }
  }
  */

  dispose(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.statusBarItem.dispose();
  }
}
