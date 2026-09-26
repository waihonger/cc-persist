import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Disposable, ExtensionContext, Terminal } from "vscode";
import { window } from "vscode";
import { _setActiveTerminal, _setConfiguration, _setTerminals, window as mockWindow } from "./__mocks__/vscode";
import { RegistryWatcher, type PidSessionOutcome } from "../src/registryWatcher";
import { TerminalManager } from "../src/terminalManager";
import * as registry from "../src/sessionRegistry";
import * as processes from "../src/pidResolver";
import * as config from "../src/config";
import { activate } from "../src/extension";

const row: registry.RegistryRow = {
  pid: 88212, sessionId: "293788ff-5f8c-483b-922b-f8a5c749e9d6",
  cwd: "/tmp/project", name: "research", status: "busy", kind: "interactive",
};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 500));
let root: string;
let sessionsDir: string;
let stateDir: string;
let metadataDir: string;
let subscriptions: Disposable[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-registry-watcher-"));
  [sessionsDir, stateDir, metadataDir] = ["sessions", "state", "metadata"].map(name => path.join(root, name));
  for (const dir of [sessionsDir, stateDir, metadataDir]) fs.mkdirSync(dir);
  subscriptions = [];
  _setConfiguration({});
  _setActiveTerminal(undefined);
  _setTerminals([]);
});

afterEach(() => {
  for (const disposable of subscriptions.reverse()) disposable.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  _setConfiguration({});
  _setActiveTerminal(undefined);
  _setTerminals([]);
  for (const dir of [sessionsDir, stateDir, metadataDir]) {
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    fs.rmdirSync(dir);
  }
  fs.rmdirSync(root);
});

function writeRow(value = row): void {
  fs.writeFileSync(path.join(sessionsDir, `${value.pid}.json`), JSON.stringify(value));
}

function watch(read: typeof registry.readRegistry, onRow = vi.fn<ConstructorParameters<typeof RegistryWatcher>[2]>()
  .mockResolvedValue("adopted"), start = true) {
  const snapshot = vi.fn(async () => new Map<number, processes.ProcEntry>());
  const watcher = new RegistryWatcher(sessionsDir, window.createOutputChannel("test"), onRow, read, snapshot);
  subscriptions.push(watcher);
  if (start) watcher.start();
  return { watcher, onRow, snapshot };
}

describe("RegistryWatcher", () => {
  it("defers startup until restore completes and adopts each row exactly once", async () => {
    const read = vi.fn().mockResolvedValue([row]);
    const { watcher, onRow } = watch(read);
    await tick();
    expect(read).not.toHaveBeenCalled();
    watcher.markRestoreComplete();
    await vi.waitFor(() => expect(onRow).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith({ sessionsDir });
    expect(onRow).toHaveBeenCalledWith(row.pid, row.sessionId, row.cwd, expect.any(Promise));

    watcher.markRestoreComplete();
    writeRow();
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  it("adopts a new row after a real filesystem write and persists its UUID and cwd within 500 ms", async () => {
    const manager = new TerminalManager(stateDir, metadataDir, root, window.createOutputChannel("test"));
    subscriptions.push({ dispose: () => manager.disposeAll() });
    const terminal = window.createTerminal({});
    const read = vi.fn(() => registry.readRegistry({ sessionsDir, runAgents: async () => { throw new Error("use fixture files"); } }));
    const onRow = vi.fn(async (_pid: number, sid: string, cwd: string | undefined): Promise<PidSessionOutcome> =>
      manager.adoptWithSessionId(terminal, sid, cwd) ? "adopted" : "retry");
    const { watcher } = watch(read, onRow);
    watcher.markRestoreComplete();
    await tick();
    expect(onRow).not.toHaveBeenCalled();

    writeRow();
    await tick();
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(manager.loadState()).toEqual({ version: 2, terminals: [{ index: 0, sessionId: row.sessionId, cwd: row.cwd }] });
  });

  it("retries three times at two-second intervals after the initial attempt, then stops", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue([row]);
    const onRow = vi.fn<ConstructorParameters<typeof RegistryWatcher>[2]>().mockResolvedValue("retry");
    // Exercise the adoption retry clock independently of OS watch recovery.
    const { watcher } = watch(read, onRow, false);
    watcher.markRestoreComplete();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRow).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= 4; attempt++) {
      await vi.advanceTimersByTimeAsync(1999);
      expect(onRow).toHaveBeenCalledTimes(attempt - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(onRow).toHaveBeenCalledTimes(attempt);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRow).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("debounces a burst of 20 files into one reconcile with one shared process snapshot", async () => {
    const rows: registry.RegistryRow[] = [];
    const read = vi.fn(async () => [...rows]);
    const { watcher, onRow, snapshot } = watch(read);
    watcher.markRestoreComplete();
    await tick();
    read.mockClear();
    for (let i = 0; i < 20; i++) {
      const next = { ...row, pid: row.pid + i };
      rows.push(next);
      writeRow(next);
    }
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onRow).toHaveBeenCalledTimes(20);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(new Set(onRow.mock.calls.map(call => call[3])).size).toBe(1);
  });

  it("fires the public status callback once for busy to idle, including an already adopted pid", async () => {
    const read = vi.fn().mockResolvedValue([row]);
    const { watcher, onRow } = watch(read);
    const changed = vi.fn();
    watcher.onStatusChange = changed;
    watcher.markRestoreComplete();
    await tick();
    expect(changed).not.toHaveBeenCalled();
    const idle = { ...row, status: "idle" };
    read.mockResolvedValue([idle]);
    writeRow(idle);
    await tick();
    expect(changed).toHaveBeenCalledExactlyOnceWith(row.pid, "busy", "idle", idle);
    writeRow(idle);
    await tick();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  it("negative control: an empty registry adopts nothing and leaves state.json untouched", async () => {
    vi.useFakeTimers();
    const statePath = path.join(stateDir, "state.json");
    const original = JSON.stringify({ version: 2, terminals: [{ index: 7, sessionId: row.sessionId }] }, null, 2);
    fs.writeFileSync(statePath, original);
    fs.utimesSync(statePath, new Date(0), new Date(0));
    const before = fs.statSync(statePath);
    writeRow(); // A file exists, but the injected read result is authoritative.
    const manager = new TerminalManager(stateDir, metadataDir, root, window.createOutputChannel("test"));
    subscriptions.push({ dispose: () => manager.disposeAll() });
    const terminal = window.createTerminal({});
    const adopt = vi.spyOn(manager, "adoptWithSessionId");
    const onRow = vi.fn(async (_pid: number, sid: string, cwd: string | undefined): Promise<PidSessionOutcome> =>
      manager.adoptWithSessionId(terminal, sid, cwd) ? "adopted" : "retry");
    const read = vi.fn().mockResolvedValue([]);
    const { watcher, snapshot } = watch(read, onRow, false);
    watcher.markRestoreComplete();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionsDir });
    expect(onRow).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(manager.isTracked(terminal)).toBe(false);
    expect(fs.readFileSync(statePath, "utf8")).toBe(original);
    const after = fs.statSync(statePath);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs })
      .toEqual({ ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
  });
});

describe("notifications through extension.activate", () => {
  async function activateFixture(settings: Record<string, unknown> = {}) {
    _setConfiguration(settings);
    const terminal = {
      name: "Terminal", processId: Promise.resolve(9000), exitStatus: undefined,
      show: vi.fn(), dispose: vi.fn(),
    } as unknown as Terminal;
    _setTerminals([terminal]);
    vi.spyOn(config, "resolveStateDir").mockReturnValue(stateDir);
    vi.spyOn(config, "resolveSignalBaseDir").mockReturnValue(metadataDir);
    vi.spyOn(config, "resolveStartDirectory").mockReturnValue(root);
    vi.spyOn(registry, "resolveSessionsDir").mockReturnValue(sessionsDir);
    vi.spyOn(registry, "readRegistry").mockResolvedValue([row]);
    vi.spyOn(processes, "snapshotProcesses").mockResolvedValue(new Map([
      [row.pid, { pid: row.pid, ppid: 9000, startedAtMs: null, command: "claude" }],
      [9000, { pid: 9000, ppid: 1, startedAtMs: null, command: "/bin/zsh" }],
    ]));
    // Keep activate, initial reconciliation, ancestry lookup and persistence real.
    // Only OS watch startup is suppressed; transitions enter the public callback.
    let watcher: RegistryWatcher | undefined;
    vi.spyOn(RegistryWatcher.prototype, "start").mockImplementation(function (this: RegistryWatcher) {
      watcher = this;
    });
    const information = vi.spyOn(mockWindow, "showInformationMessage").mockResolvedValue(undefined);
    const warning = vi.spyOn(mockWindow, "showWarningMessage").mockResolvedValue(undefined);
    const adopted = vi.spyOn(TerminalManager.prototype, "adoptWithSessionId");
    await activate({ subscriptions } as unknown as ExtensionContext);
    await vi.waitFor(() => expect(adopted).toHaveReturnedWith(true));
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")))
      .toEqual({ version: 2, terminals: [{ index: 0, sessionId: row.sessionId, cwd: row.cwd }] });
    expect(watcher?.onStatusChange).toBeTypeOf("function");
    const transition = async (to: string, changed: registry.RegistryRow = row, from = "busy") => {
      watcher!.onStatusChange!(changed.pid, from, to, { ...changed, status: to });
      await Promise.resolve();
    };
    return { terminal, information, warning, transition };
  }

  it.each([{}, { notifications: false }])("keeps notifications off for configuration %j", async (settings) => {
    const { information, warning, terminal, transition } = await activateFixture(settings);
    await transition("idle");
    await transition("waiting");
    expect(information).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(terminal.show).not.toHaveBeenCalled();
  });

  it("shows the done toast for a tracked background terminal and Show focuses it", async () => {
    const { information, warning, terminal, transition } = await activateFixture({ notifications: true });
    information.mockResolvedValue("Show");
    await transition("idle");
    expect(information).toHaveBeenCalledExactlyOnceWith("research: done", "Show");
    expect(warning).not.toHaveBeenCalled();
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("shows the needs-input warning and Show focuses the tracked background terminal", async () => {
    const { information, warning, terminal, transition } = await activateFixture({ notifications: true });
    warning.mockResolvedValue("Show");
    await transition("waiting");
    expect(warning).toHaveBeenCalledExactlyOnceWith("research: needs input", "Show");
    expect(information).not.toHaveBeenCalled();
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("uses the terminal index when the row has no name and dismissal does not focus", async () => {
    const { information, terminal, transition } = await activateFixture({ notifications: true });
    await transition("idle", { ...row, name: undefined });
    expect(information).toHaveBeenCalledExactlyOnceWith("0: done", "Show");
    expect(terminal.show).not.toHaveBeenCalled();
  });

  it("suppresses both notifications for the active terminal", async () => {
    const { information, warning, terminal, transition } = await activateFixture({ notifications: true });
    _setActiveTerminal(terminal);
    await transition("idle");
    await transition("waiting");
    expect(information).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("ignores unknown pids and transitions other than busy to idle or waiting", async () => {
    const { information, warning, transition } = await activateFixture({ notifications: true });
    await transition("idle", { ...row, pid: 12345 });
    await transition("waiting", { ...row, pid: 12345 });
    await transition("idle", row, "waiting");
    await transition("busy");
    expect(information).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("reads notification configuration again after activation", async () => {
    const { information, warning, transition } = await activateFixture();
    _setConfiguration({ notifications: true });
    await transition("idle");
    expect(information).toHaveBeenCalledExactlyOnceWith("research: done", "Show");
    _setConfiguration({ notifications: false });
    await transition("waiting");
    expect(warning).not.toHaveBeenCalled();
  });
});
