import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { signalDir } from "./config";
import type { SessionInfo, SessionState } from "./types";

/** Only allow safe characters in session names — prevents shell injection via sendText. */
const SAFE_NAME_RE = /^[a-zA-Z0-9_.\-][a-zA-Z0-9_.\- ]*[a-zA-Z0-9_.\-]$/;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME_FLAGS_RE = /^[A-Za-z0-9 _.=-]*$/;
const DEFAULT_RESUME_FLAGS = "--dangerously-skip-permissions";
const SHELL_INTEGRATION_TIMEOUT_MS = 3000;

/** Delay before cleaning up terminal state on close. Gives setDisposing() time to cancel
 *  during shutdown — terminal close events fire before deactivate(). */
export const CLEANUP_DELAY_MS = 300;

export function isValidSessionName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 64) return false;
  // Single-char names: must be alphanumeric/underscore/dot/dash (no space)
  if (name.length === 1) return /^[a-zA-Z0-9_.\-]$/.test(name);
  return SAFE_NAME_RE.test(name);
}

export function isValidSessionId(sessionId: unknown): boolean {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

export function isValidIndex(index: unknown): boolean {
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < Number.MAX_SAFE_INTEGER;
}

function normalizeEntry(entry: unknown, version: number): SessionInfo | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (!isValidIndex(e.index)) return null;

  const name = typeof e.name === "string" && isValidSessionName(e.name) ? e.name : undefined;
  const sessionId = version === 2 && typeof e.sessionId === "string" && isValidSessionId(e.sessionId)
    ? e.sessionId
    : undefined;
  if (!sessionId && !name) return null;

  return { index: e.index as number, ...(sessionId ? { sessionId } : {}), ...(name ? { name } : {}) };
}

export class TerminalManager {
  private readonly stateDir: string;
  private readonly signalBaseDir: string;
  private readonly startDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly terminalToIndex = new Map<vscode.Terminal, number>();
  private readonly indexToTerminal = new Map<number, vscode.Terminal>();
  private readonly indexToSessionId = new Map<number, string>();
  private readonly sessionNames = new Map<vscode.Terminal, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingCleanups = new Map<vscode.Terminal, NodeJS.Timeout>();
  private readonly pendingCommands = new Map<vscode.Terminal, {
    timeout: NodeJS.Timeout;
    listener: vscode.Disposable;
  }>();
  private readonly cleanupDelayMs: number;
  private readonly resumeFlags: string;
  private nextIndex = 0;
  private disposing = false;
  private restored = false;
  private onTerminalClosedCallback: ((index: number) => void) | undefined;

  constructor(
    stateDir: string,
    signalBaseDir: string,
    startDir: string,
    log: vscode.OutputChannel,
    cleanupDelayMs = 0,
    resumeFlags = DEFAULT_RESUME_FLAGS,
  ) {
    this.stateDir = stateDir;
    this.signalBaseDir = signalBaseDir;
    this.startDir = startDir;
    this.log = log;
    this.cleanupDelayMs = cleanupDelayMs;
    if (typeof resumeFlags === "string" && RESUME_FLAGS_RE.test(resumeFlags)) {
      this.resumeFlags = resumeFlags;
    } else {
      this.resumeFlags = DEFAULT_RESUME_FLAGS;
      this.log.appendLine("Invalid resumeFlags setting — using default");
    }
  }

  private get statePath(): string {
    return path.join(this.stateDir, "state.json");
  }

  private get sigDir(): string {
    return signalDir(this.signalBaseDir);
  }

  loadState(): SessionState {
    this.log.appendLine(`Loading state from: ${this.statePath}`);
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      this.log.appendLine(`State file contents: ${raw}`);
      const data = JSON.parse(raw);
      if (data && (data.version === 1 || data.version === 2) && Array.isArray(data.terminals)) {
        const valid = data.terminals
          .map((e: unknown) => normalizeEntry(e, data.version))
          .filter((e: SessionInfo | null): e is SessionInfo => e !== null);
        this.log.appendLine(`Valid entries: ${valid.length}/${data.terminals.length}`);
        return { version: 2, terminals: valid };
      }
      this.log.appendLine(`State schema mismatch: version=${data?.version}, isArray=${Array.isArray(data?.terminals)}`);
    } catch (err) {
      this.log.appendLine(`Failed to load state: ${err}`);
    }
    return { version: 2, terminals: [] };
  }

  saveState(): void {
    const terminals: SessionInfo[] = [];
    const names: Record<string, string> = {};
    for (const [terminal, index] of this.terminalToIndex) {
      const name = this.sessionNames.get(terminal) ?? terminal.name;
      names[index] = name;
      const sessionId = this.indexToSessionId.get(index);
      const sessionName = this.sessionNames.get(terminal);
      if (!sessionId && !sessionName) continue;
      terminals.push({ index, ...(sessionId ? { sessionId } : {}), ...(sessionName ? { name: sessionName } : {}) });
    }
    terminals.sort((a, b) => a.index - b.index);

    const state: SessionState = { version: 2, terminals };
    try {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.statePath, JSON.stringify(state), { mode: 0o600 });
      this.log.appendLine(`Saved state: ${terminals.length} terminal(s)`);
    } catch (err) {
      this.log.appendLine(`Failed to save state: ${err}`);
    }

    // Write names.json for cc-overlord compatibility
    try {
      fs.mkdirSync(this.signalBaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.signalBaseDir, "names.json"),
        JSON.stringify(names),
        { mode: 0o600 },
      );
    } catch (err) {
      this.log.appendLine(`Failed to write names.json: ${err}`);
    }
  }

  createTerminal(_unusedName?: string): vscode.Terminal {
    const index = this.nextIndex++;

    fs.mkdirSync(this.sigDir, { recursive: true });

    const terminal = vscode.window.createTerminal({
      env: {
        DTACH_SIGNAL_DIR: this.sigDir,
        DTACH_SOCKET_INDEX: index.toString(),
      },
      cwd: this.startDir,
      isTransient: true,
    });

    this.terminalToIndex.set(terminal, index);
    this.indexToTerminal.set(index, terminal);
    // Immediate sendText, not sendCommand: the env is already injected via
    // createTerminal options, this line is belt-and-braces — a delayed fallback
    // could type into a claude the user has already started in this terminal.
    terminal.sendText(`export DTACH_SIGNAL_DIR='${this.sigDir}' DTACH_SOCKET_INDEX='${index}'`);
    this.log.appendLine(`Created terminal ${index}`);
    return terminal;
  }

  restoreTerminals(): vscode.Terminal[] {
    if (this.restored) {
      this.log.appendLine("restoreTerminals already called — skipping");
      return [];
    }
    this.restored = true;

    const state = this.loadState();
    if (state.terminals.length === 0) return [];

    fs.mkdirSync(this.sigDir, { recursive: true });

    const seenIndices = new Set<number>();
    const restored: vscode.Terminal[] = [];
    for (const info of state.terminals) {
      // Skip duplicate indices
      if (seenIndices.has(info.index)) {
        this.log.appendLine(`Skipping duplicate index ${info.index}`);
        continue;
      }
      seenIndices.add(info.index);

      // Set nextIndex to avoid collisions
      if (info.index >= this.nextIndex) {
        this.nextIndex = info.index + 1;
      }

      const terminal = vscode.window.createTerminal({
        env: {
          DTACH_SIGNAL_DIR: this.sigDir,
          DTACH_SOCKET_INDEX: info.index.toString(),
        },
        cwd: this.startDir,
        isTransient: true,
      });

      this.terminalToIndex.set(terminal, info.index);
      this.indexToTerminal.set(info.index, terminal);

      if (info.sessionId) this.indexToSessionId.set(info.index, info.sessionId);
      if (info.name) this.sessionNames.set(terminal, info.name);
      const handle = info.sessionId ?? info.name!;
      this.sendCommand(terminal, `export DTACH_SIGNAL_DIR='${this.sigDir}' DTACH_SOCKET_INDEX='${info.index}' && claude ${this.resumeFlags} --resume '${handle}'`);
      this.log.appendLine(`Restored terminal ${info.index}: ${info.name ?? info.sessionId}`);
      restored.push(terminal);
    }

    return restored;
  }

  handleTerminalClosed(terminal: vscode.Terminal): void {
    const index = this.terminalToIndex.get(terminal);
    if (index === undefined) return;

    if (this.disposing) {
      this.log.appendLine(`Terminal ${index} closed (shutdown) — state on disk preserved`);
      return;
    }

    // Fire signal cleanup callback immediately
    this.onTerminalClosedCallback?.(index);

    // Delay map cleanup + state save so setDisposing() can cancel during shutdown.
    // Terminal close events fire before deactivate() — without this delay, maps get
    // emptied and saveState() writes empty state before setDisposing() has a chance to run.
    const doCleanup = () => {
      this.pendingCleanups.delete(terminal);
      this.terminalToIndex.delete(terminal);
      this.indexToTerminal.delete(index);
      this.indexToSessionId.delete(index);
      this.sessionNames.delete(terminal);
      this.clearPendingCommand(terminal);
      this.saveState();
      this.log.appendLine(`Terminal ${index} closed by user — state saved, ${this.terminalToIndex.size} remaining`);
    };

    if (this.cleanupDelayMs === 0) {
      doCleanup();
    } else {
      const timeout = setTimeout(doCleanup, this.cleanupDelayMs);
      this.pendingCleanups.set(terminal, timeout);
    }
  }

  registerEventHandlers(context: vscode.ExtensionContext): void {
    const closeDisposable = vscode.window.onDidCloseTerminal((terminal) =>
      this.handleTerminalClosed(terminal),
    );
    this.disposables.push(closeDisposable);
    context.subscriptions.push(closeDisposable);

  }

  writeWorkspaceMetadata(): void {
    fs.mkdirSync(this.signalBaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.signalBaseDir, "workspace.json"),
      JSON.stringify({ path: this.startDir }),
      { mode: 0o600 },
    );
  }

  isTracked(terminal: vscode.Terminal): boolean {
    return this.terminalToIndex.has(terminal);
  }

  getIndex(terminal: vscode.Terminal): number | undefined {
    return this.terminalToIndex.get(terminal);
  }

  getSavedName(index: number): string | undefined {
    const terminal = this.indexToTerminal.get(index);
    if (!terminal) return undefined;
    return this.sessionNames.get(terminal) ?? terminal.name;
  }

  setSessionId(index: number, sid: string): void {
    if (!isValidIndex(index) || !isValidSessionId(sid)) {
      this.log.appendLine(`Ignoring invalid session ID for terminal ${index}: ${sid}`);
      return;
    }
    // Only accept session IDs for live tracked terminals — a stale .sid for an
    // unknown index must not trigger a save (saving with empty maps would
    // overwrite state.json and wipe every saved session).
    if (!this.indexToTerminal.has(index)) {
      this.log.appendLine(`Ignoring session ID for untracked terminal ${index}`);
      return;
    }
    this.indexToSessionId.set(index, sid);
    this.saveState();
  }

  renameTerminal(terminal: vscode.Terminal, name: string): string | null {
    if (!isValidSessionName(name)) return null;
    if (!this.terminalToIndex.has(terminal)) {
      this.adoptTerminal(terminal);
    }
    this.sessionNames.delete(terminal);
    const unique = this.resolveUniqueName(name);
    this.sessionNames.set(terminal, unique);
    const index = this.terminalToIndex.get(terminal);
    this.log.appendLine(`Renamed terminal ${index}: ${unique}`);
    return unique;
  }

  private resolveUniqueName(base: string): string {
    const MAX = 64;
    const taken = new Set(this.sessionNames.values());
    if (!taken.has(base)) return base;
    let n = 2;
    while (true) {
      const suffix = `-${n}`;
      const truncated = base.length + suffix.length > MAX ? base.slice(0, MAX - suffix.length) : base;
      const candidate = `${truncated}${suffix}`;
      if (!taken.has(candidate)) return candidate;
      n++;
    }
  }

  private adoptTerminal(terminal: vscode.Terminal): void {
    const index = this.nextIndex++;
    this.terminalToIndex.set(terminal, index);
    this.indexToTerminal.set(index, terminal);
    this.log.appendLine(`Adopted terminal ${index}: ${terminal.name}`);
  }

  getSessionName(terminal: vscode.Terminal): string | undefined {
    return this.sessionNames.get(terminal);
  }

  showTerminal(index: number): void {
    const terminal = this.indexToTerminal.get(index);
    if (terminal) terminal.show();
  }

  showFirst(): void {
    const first = this.indexToTerminal.values().next().value;
    if (first) first.show();
  }

  setOnTerminalClosed(callback: (index: number) => void): void {
    this.onTerminalClosedCallback = callback;
  }

  setDisposing(): void {
    if (this.disposing) return;
    this.disposing = true;
    // Cancel pending cleanups from terminal close events that fired before us
    const cancelledCount = this.pendingCleanups.size;
    for (const timeout of this.pendingCleanups.values()) {
      clearTimeout(timeout);
    }
    this.pendingCleanups.clear();
    this.saveState();
    this.log.appendLine(`Disposing — cancelled ${cancelledCount} pending cleanups, state saved`);
  }

  private sendCommand(terminal: vscode.Terminal, text: string): void {
    if (terminal.shellIntegration) {
      terminal.shellIntegration.executeCommand(text);
      return;
    }

    const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal) return;
      this.clearPendingCommand(terminal);
      event.shellIntegration.executeCommand(text);
    });
    const timeout = setTimeout(() => {
      this.clearPendingCommand(terminal);
      terminal.sendText(text);
    }, SHELL_INTEGRATION_TIMEOUT_MS);
    this.pendingCommands.set(terminal, { timeout, listener });

    const currentShellIntegration = this.getShellIntegration(terminal);
    if (currentShellIntegration) {
      this.clearPendingCommand(terminal);
      currentShellIntegration.executeCommand(text);
    }
  }

  private getShellIntegration(terminal: vscode.Terminal): vscode.TerminalShellIntegration | undefined {
    return terminal.shellIntegration;
  }

  private clearPendingCommand(terminal: vscode.Terminal): void {
    const pending = this.pendingCommands.get(terminal);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.listener.dispose();
    this.pendingCommands.delete(terminal);
  }

  disposeAll(): void {
    for (const timeout of this.pendingCleanups.values()) {
      clearTimeout(timeout);
    }
    this.pendingCleanups.clear();
    for (const terminal of this.pendingCommands.keys()) {
      this.clearPendingCommand(terminal);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.terminalToIndex.clear();
    this.indexToTerminal.clear();
    this.indexToSessionId.clear();
    this.sessionNames.clear();
  }
}
