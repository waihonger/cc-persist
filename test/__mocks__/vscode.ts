type Callback = (...args: unknown[]) => void;

class EventEmitter {
  private listeners: Callback[] = [];
  event = (cb: Callback) => {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== cb); } };
  };
  fire(...args: unknown[]) {
    for (const cb of this.listeners) cb(...args);
  }
}

export const _onDidCloseTerminal = new EventEmitter();
export const _onDidOpenTerminal = new EventEmitter();
export const _onDidChangeActiveTerminal = new EventEmitter();
export const _onDidChangeWindowState = new EventEmitter();
export const _onDidChangeTerminalShellIntegration = new EventEmitter();
export let _activeTerminal: unknown = undefined;
export function _setActiveTerminal(t: unknown) { _activeTerminal = t; }

let _configuration: Record<string, unknown> = {};
export function _setConfiguration(values: Record<string, unknown>) { _configuration = values; }

export const workspace = {
  workspaceFolders: [
    {
      uri: { fsPath: "/Users/test/my-project" },
      name: "my-project",
      index: 0,
    },
  ],
  getConfiguration: () => ({
    get: (key: string, defaultValue?: unknown) => key in _configuration ? _configuration[key] : defaultValue,
  }),
};

let _terminals: unknown[] = [];
export function _setTerminals(t: unknown[]) { _terminals = t; }
export function _attachShellIntegration(terminal: unknown, executeCommand: (text: string) => unknown = () => {}) {
  const shellIntegration = { executeCommand };
  (terminal as { shellIntegration?: unknown }).shellIntegration = shellIntegration;
  _onDidChangeTerminalShellIntegration.fire({ terminal, shellIntegration });
  return shellIntegration;
}

export const window = {
  get terminals() { return _terminals; },
  get activeTerminal() { return _activeTerminal; },
  state: { focused: true },
  createOutputChannel: () => ({
    appendLine: () => {},
    dispose: () => {},
  }),
  showErrorMessage: () => {},
  showWarningMessage: () => {},
  showInformationMessage: () => {},
  createTerminal: (opts: unknown) => {
    const t = { name: (opts as Record<string, unknown>)?.name || "Terminal", creationOptions: opts, show: () => {}, dispose: () => {}, processId: Promise.resolve(999), sendText: () => {}, exitStatus: { reason: 2 /* Process */ } };
    return t;
  },
  onDidCloseTerminal: _onDidCloseTerminal.event,
  onDidOpenTerminal: _onDidOpenTerminal.event,
  onDidChangeActiveTerminal: _onDidChangeActiveTerminal.event,
  onDidChangeWindowState: _onDidChangeWindowState.event,
  onDidChangeTerminalShellIntegration: _onDidChangeTerminalShellIntegration.event,
  registerTerminalProfileProvider: () => ({ dispose: () => {} }),
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: "",
    backgroundColor: undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  showQuickPick: async () => undefined,
};

export const commands = {
  registerCommand: (_cmd: string, _cb: Callback) => ({ dispose: () => {} }),
};

export class TerminalProfile {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class ThemeColor {
  id: string;
  constructor(id: string) { this.id = id; }
}

export enum TerminalExitReason {
  Unknown = 0,
  Shutdown = 1,
  Process = 2,
  Extension = 3,
}
