import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { signalDir } from "./config";
import type { SessionInfo, SessionState } from "./types";

/** Only allow safe characters in session names — prevents shell injection via sendText. */
const SAFE_NAME_RE = /^[a-zA-Z0-9_.\-][a-zA-Z0-9_.\- ]*[a-zA-Z0-9_.\-]$/;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME_FLAGS_RE = /^[A-Za-z0-9 _.=-]*$/;
/** Single source of truth in code; package.json's declared default must match. */
export const DEFAULT_RESUME_FLAGS = "--dangerously-skip-permissions";

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

function isValidSessionCwd(cwd: unknown): cwd is string {
  return typeof cwd === "string"
    && cwd.length <= 1024
    && !/[\0\r\n]/.test(cwd)
    && path.isAbsolute(cwd);
}

/** Parse the JSON SessionStart payload, while retaining bare UUID compatibility. */
export function parseSidPayload(raw: string): { sessionId: string; cwd?: string } | null {
  const trimmed = raw.trim();
  if (isValidSessionId(trimmed)) return { sessionId: trimmed };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  const sessionId = payload.sessionId;
  if (!isValidSessionId(sessionId)) return null;
  const cwd = isValidSessionCwd(payload.cwd) ? payload.cwd : undefined;
  return { sessionId: sessionId as string, ...(cwd ? { cwd } : {}) };
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
  const cwd = isValidSessionCwd(e.cwd) ? e.cwd : undefined;
  if (!sessionId && !name) return null;

  return {
    index: e.index as number,
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

export class TerminalManager {
  private readonly stateDir: string;
  private readonly signalBaseDir: string;
  private readonly startDir: string;
  private readonly log: vscode.OutputChannel;
  private readonly terminalToIndex = new Map<vscode.Terminal, number>();
  private readonly indexToTerminal = new Map<number, vscode.Terminal>();
  private readonly indexToSessionId = new Map<number, string>();
  private readonly indexToCwd = new Map<number, string>();
  private readonly sessionNames = new Map<vscode.Terminal, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly resumeFlags: string;
  private readonly shellPath: string | undefined;
  private nextIndex = 0;
  private restored = false;
  private onTerminalClosedCallback: ((index: number) => void) | undefined;

  constructor(
    stateDir: string,
    signalBaseDir: string,
    startDir: string,
    log: vscode.OutputChannel,
    resumeFlags = DEFAULT_RESUME_FLAGS,
    shellPath?: string,
  ) {
    this.stateDir = stateDir;
    this.signalBaseDir = signalBaseDir;
    this.startDir = startDir;
    this.log = log;
    this.shellPath = shellPath;
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

  private writeAtomic(filePath: string, data: string): void {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, data, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
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

  saveState(): boolean {
    const terminals: SessionInfo[] = [];
    const names: Record<string, string> = {};
    for (const [terminal, index] of this.terminalToIndex) {
      const name = this.sessionNames.get(terminal) ?? terminal.name;
      names[index] = name;
      const sessionId = this.indexToSessionId.get(index);
      const cwd = this.indexToCwd.get(index);
      const sessionName = this.sessionNames.get(terminal);
      if (!sessionId && !sessionName) continue;
      terminals.push({
        index,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionName ? { name: sessionName } : {}),
        ...(cwd ? { cwd } : {}),
      });
    }
    terminals.sort((a, b) => a.index - b.index);

    const state: SessionState = { version: 2, terminals };
    let saved = false;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      this.writeAtomic(this.statePath, JSON.stringify(state));
      this.log.appendLine(`Saved state: ${terminals.length} terminal(s)`);
      saved = true;
    } catch (err) {
      this.log.appendLine(`Failed to save state: ${err}`);
    }

    // Write names.json for cc-overlord compatibility
    try {
      fs.mkdirSync(this.signalBaseDir, { recursive: true });
      const namesPath = path.join(this.signalBaseDir, "names.json");
      this.writeAtomic(namesPath, JSON.stringify(names));
    } catch (err) {
      this.log.appendLine(`Failed to write names.json: ${err}`);
    }
    return saved;
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
      // Unknown codicon id renders no glyph and reserves no width; bypasses the
      // profile-icon lookup that would otherwise show VS Code's terminal icon.
      iconPath: new vscode.ThemeIcon("none"),
    });

    this.terminalToIndex.set(terminal, index);
    this.indexToTerminal.set(index, terminal);
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

      const handle = info.sessionId ?? info.name!;
      const cmd = `claude ${this.resumeFlags} --resume '${handle}'`;
      const cwd = info.cwd && fs.existsSync(info.cwd) ? info.cwd : this.startDir;
      const shellPath = this.shellPath;
      const shellName = shellPath ? path.basename(shellPath) : "";
      const useShellArgs = !!shellPath && /^(zsh|bash)$/.test(shellName) && !shellPath.includes("'");
      const options = {
        ...(useShellArgs ? {
          shellPath,
          shellArgs: ["-lc", `${cmd}; exec '${shellPath}' -il`],
        } : {}),
        env: {
          DTACH_SIGNAL_DIR: this.sigDir,
          DTACH_SOCKET_INDEX: info.index.toString(),
        },
        cwd,
        isTransient: true,
        iconPath: new vscode.ThemeIcon("none"),
      };
      const terminal = vscode.window.createTerminal(options);
      if (!useShellArgs) terminal.sendText(cmd);

      this.terminalToIndex.set(terminal, info.index);
      this.indexToTerminal.set(info.index, terminal);

      if (info.sessionId) this.indexToSessionId.set(info.index, info.sessionId);
      if (info.cwd) this.indexToCwd.set(info.index, info.cwd);
      if (info.name) this.sessionNames.set(terminal, info.name);
      this.log.appendLine(`Restored terminal ${info.index}: ${info.name ?? info.sessionId}`);
      restored.push(terminal);
    }

    return restored;
  }

  handleTerminalClosed(terminal: vscode.Terminal): void {
    const index = this.terminalToIndex.get(terminal);
    if (index === undefined) return;

    const reason = terminal.exitStatus?.reason;
    const prune = reason === vscode.TerminalExitReason.User;
    // Only User prunes. Process is ambiguous; Shutdown (window close/reload),
    // Extension, Unknown and undefined also preserve. A spuriously kept entry costs
    // one extra restored tab, while a spuriously pruned entry loses a session.
    if (!prune) {
      this.log.appendLine(`Terminal ${index} closed (reason ${reason ?? "unknown"}) — state on disk preserved`);
      return;
    }

    this.onTerminalClosedCallback?.(index);
    this.terminalToIndex.delete(terminal);
    this.indexToTerminal.delete(index);
    this.indexToSessionId.delete(index);
    this.indexToCwd.delete(index);
    this.sessionNames.delete(terminal);
    this.saveState();
    this.log.appendLine(`Terminal ${index} closed by user — state saved, ${this.terminalToIndex.size} remaining`);
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

  /** Returns true only when the session ID was accepted AND persisted to disk —
   *  the caller keeps the source .sid file for retry on false. */
  setSessionId(index: number, sid: string, cwd?: string): boolean {
    if (!isValidIndex(index) || !isValidSessionId(sid)) {
      this.log.appendLine(`Ignoring invalid session ID for terminal ${index}: ${sid}`);
      return false;
    }
    // Only accept session IDs for live tracked terminals — a stale .sid for an
    // unknown index must not trigger a save (saving with empty maps would
    // overwrite state.json and wipe every saved session).
    if (!this.indexToTerminal.has(index)) {
      this.log.appendLine(`Ignoring session ID for untracked terminal ${index}`);
      return false;
    }
    this.indexToSessionId.set(index, sid);
    this.setCwd(index, cwd);
    return this.saveState();
  }

  /** Adopt a terminal cc-persist didn't create and persist its session ID.
   *  Returns true only when accepted AND persisted. */
  adoptWithSessionId(terminal: vscode.Terminal, sid: string, cwd?: string): boolean {
    if (!isValidSessionId(sid)) {
      this.log.appendLine(`Ignoring invalid session ID for terminal ${terminal.name}: ${sid}`);
      return false;
    }
    const index = this.terminalToIndex.get(terminal) ?? this.adoptTerminal(terminal);
    this.indexToSessionId.set(index, sid);
    this.setCwd(index, cwd);
    return this.saveState();
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

  private adoptTerminal(terminal: vscode.Terminal): number {
    const index = this.nextIndex++;
    this.terminalToIndex.set(terminal, index);
    this.indexToTerminal.set(index, terminal);
    this.log.appendLine(`Adopted terminal ${index}: ${terminal.name}`);
    return index;
  }

  private setCwd(index: number, cwd: string | undefined): void {
    if (isValidSessionCwd(cwd)) {
      this.indexToCwd.set(index, cwd);
    } else {
      this.indexToCwd.delete(index);
    }
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

  disposeAll(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.terminalToIndex.clear();
    this.indexToTerminal.clear();
    this.indexToSessionId.clear();
    this.indexToCwd.clear();
    this.sessionNames.clear();
  }
}
