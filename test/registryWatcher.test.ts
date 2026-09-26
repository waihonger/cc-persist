import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Disposable, ExtensionContext, Terminal } from "vscode";
import { window } from "vscode";
import { _createEnvironmentVariableCollection, _setActiveTerminal, _setConfiguration, _setTerminals, window as mockWindow } from "./__mocks__/vscode";
import { RegistryWatcher, type PidSessionOutcome } from "../src/registryWatcher";
import { TerminalManager } from "../src/terminalManager";
import * as registry from "../src/sessionRegistry";
import * as processes from "../src/pidResolver";
import * as config from "../src/config";
import { activate } from "../src/extension";

// Keep file reads and writes real; deliver watch events explicitly for deterministic unit tests.
vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  watch: vi.fn(),
}));

const watchListeners = new Set<fs.WatchListener<string>>();

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
  watchListeners.clear();
  vi.mocked(fs.watch).mockReset();
  vi.mocked(fs.watch).mockImplementation(((_directory: fs.PathLike, listener: fs.WatchListener<string>) => {
    watchListeners.add(listener);
    return {
      on: vi.fn().mockReturnThis(),
      close: vi.fn(() => watchListeners.delete(listener)),
    } as unknown as fs.FSWatcher;
  }) as typeof fs.watch);
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
  emitWatch(`${value.pid}.json`);
}

function emitWatch(filename = `${row.pid}.json`): void {
  for (const listener of watchListeners) listener("change", filename);
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
    expect(onRow).toHaveBeenCalledWith(row.pid, row.sessionId, row.cwd, expect.any(Promise), row.startedAt);

    watcher.markRestoreComplete();
    writeRow();
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  it("adopts a new row from a real file after a watch event and persists its UUID and cwd within 500 ms", async () => {
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

  it.each([
    { field: "sessionId", update: { sessionId: "393788ff-5f8c-483b-922b-f8a5c749e9d6" } },
    { field: "cwd", update: { cwd: "/tmp/changed-project" } },
  ])("re-adopts a changed $field but skips an unchanged payload", async ({ update }) => {
    vi.useFakeTimers();
    const initial = { ...row, startedAt: 1790397130389 };
    const read = vi.fn().mockResolvedValue([initial]);
    const { watcher, onRow } = watch(read);
    watcher.markRestoreComplete();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRow).toHaveBeenCalledExactlyOnceWith(
      initial.pid, initial.sessionId, initial.cwd, expect.any(Promise), initial.startedAt,
    );
    writeRow(initial);
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledTimes(1);

    const changed = { ...initial, ...update };
    read.mockResolvedValue([changed]);
    writeRow(changed);
    await vi.advanceTimersByTimeAsync(300);
    expect(onRow).toHaveBeenNthCalledWith(
      2, changed.pid, changed.sessionId, changed.cwd, expect.any(Promise), changed.startedAt,
    );
    writeRow(changed);
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(4);
    expect(onRow).toHaveBeenCalledTimes(2);
  });

  it("re-adopts a rewrite received while the first adoption is in flight", async () => {
    vi.useFakeTimers();
    let finish!: (outcome: PidSessionOutcome) => void;
    const held = new Promise<PidSessionOutcome>((resolve) => { finish = resolve; });
    const onRow = vi.fn<ConstructorParameters<typeof RegistryWatcher>[2]>()
      .mockImplementationOnce(() => held).mockResolvedValue("adopted");
    const read = vi.fn().mockResolvedValue([row]);
    const { watcher } = watch(read, onRow);
    watcher.markRestoreComplete();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRow).toHaveBeenCalledTimes(1);

    const changed = { ...row, sessionId: "393788ff-5f8c-483b-922b-f8a5c749e9d6", cwd: "/tmp/new" };
    read.mockResolvedValue([changed]);
    writeRow(changed);
    await vi.advanceTimersByTimeAsync(50);
    expect(onRow).toHaveBeenCalledTimes(1);
    finish("adopted");
    await vi.advanceTimersByTimeAsync(0);
    expect(onRow).toHaveBeenNthCalledWith(
      2, changed.pid, changed.sessionId, changed.cwd, expect.any(Promise), changed.startedAt,
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(onRow).toHaveBeenCalledTimes(2);
  });

  it("reconciles within two seconds during events every 100 ms for three seconds", async () => {
    vi.useFakeTimers();
    const reconciledAt: number[] = [];
    const read = vi.fn(async () => { reconciledAt.push(Date.now()); return []; });
    const { watcher } = watch(read);
    watcher.markRestoreComplete();
    await vi.advanceTimersByTimeAsync(0);
    read.mockClear();
    reconciledAt.length = 0;
    const start = Date.now();
    for (let i = 0; i < 30; i++) {
      emitWatch();
      await vi.advanceTimersByTimeAsync(100);
      if (i === 18) expect(read).not.toHaveBeenCalled();
      if (i === 19) expect(read).toHaveBeenCalledTimes(1);
    }
    expect(reconciledAt[0] - start).toBe(2000);
    expect(reconciledAt[0]).toBeLessThan(Date.now());
    await vi.advanceTimersByTimeAsync(199);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("remembers foreign payloads until they change or disappear and reappear", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue([row]);
    const onRow = vi.fn<ConstructorParameters<typeof RegistryWatcher>[2]>().mockResolvedValue("foreign");
    const { watcher } = watch(read, onRow);
    watcher.markRestoreComplete();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onRow).toHaveBeenCalledTimes(1);
    emitWatch();
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledTimes(1);

    const changed = { ...row, cwd: "/tmp/foreign-new" };
    read.mockResolvedValue([changed]);
    emitWatch();
    await vi.advanceTimersByTimeAsync(300);
    expect(onRow).toHaveBeenCalledTimes(2);
    read.mockResolvedValue([]);
    emitWatch();
    await vi.advanceTimersByTimeAsync(300);
    read.mockResolvedValue([changed]);
    emitWatch();
    await vi.advanceTimersByTimeAsync(300);
    expect(onRow).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRow).toHaveBeenCalledTimes(3);
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
    const environmentVariableCollection = _createEnvironmentVariableCollection();
    await activate({ subscriptions, environmentVariableCollection } as unknown as ExtensionContext);
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

describe("registry adoption through extension.activate", () => {
  beforeEach(() => vi.useFakeTimers());

  function terminalWithPid(processId: Promise<number | undefined>): Terminal {
    return { name: "Terminal", processId, exitStatus: undefined, show: vi.fn(), dispose: vi.fn() } as unknown as Terminal;
  }

  function ownedSnapshot(startedAtMs: number | null = null): Map<number, processes.ProcEntry> {
    return new Map([
      [row.pid, { pid: row.pid, ppid: 9000, startedAtMs, command: "claude" }],
      [9000, { pid: 9000, ppid: 1, startedAtMs: null, command: "/bin/zsh" }],
    ]);
  }

  async function activateRegistry(
    rows: registry.RegistryRow[],
    procs = ownedSnapshot(),
    terminals = [terminalWithPid(Promise.resolve(9000))],
  ) {
    _setTerminals(terminals);
    vi.spyOn(config, "resolveStateDir").mockReturnValue(stateDir);
    vi.spyOn(config, "resolveSignalBaseDir").mockReturnValue(metadataDir);
    vi.spyOn(config, "resolveStartDirectory").mockReturnValue(root);
    vi.spyOn(registry, "resolveSessionsDir").mockReturnValue(sessionsDir);
    const read = vi.spyOn(registry, "readRegistry").mockResolvedValue(rows);
    const snapshot = vi.spyOn(processes, "snapshotProcesses").mockResolvedValue(procs);
    const adopted = vi.spyOn(TerminalManager.prototype, "adoptWithSessionId");
    const log = vi.fn<(line: string) => void>();
    vi.spyOn(window, "createOutputChannel").mockReturnValue({
      appendLine: log, dispose: vi.fn(),
    } as unknown as ReturnType<typeof window.createOutputChannel>);
    const environmentVariableCollection = _createEnvironmentVariableCollection(
      { DTACH_SIGNAL_DIR: "/tmp/legacy-capture" }, "legacy description",
    );
    await activate({ subscriptions, environmentVariableCollection } as unknown as ExtensionContext);
    return { read, snapshot, adopted, log, environmentVariableCollection, terminals };
  }

  it("clears persisted capture environment mutations and description before reading the registry", async () => {
    const { read, environmentVariableCollection: collection } = await activateRegistry([row]);
    await vi.advanceTimersByTimeAsync(0);
    expect(collection.clear).toHaveBeenCalledExactlyOnceWith();
    expect(collection.mutations.size).toBe(0);
    expect(collection.description).toBe("");
    expect(collection.descriptionChanges).toHaveBeenCalledExactlyOnceWith("");
    expect(collection.replace).not.toHaveBeenCalledWith("DTACH_SIGNAL_DIR", expect.anything());
    expect(collection.replace).not.toHaveBeenCalled();
    expect(collection.clear.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });

  it.each([
    { label: "stale", startedAt: 1_000_000, expectedAdoptions: 0 },
    { label: "matching", startedAt: 2_000_000, expectedAdoptions: 1 },
  ])("honors a $label startedAt against the process generation", async ({ startedAt, expectedAdoptions }) => {
    const statePath = path.join(stateDir, "state.json");
    const original = JSON.stringify({ version: 2, terminals: [] }, null, 2);
    fs.writeFileSync(statePath, original);
    fs.utimesSync(statePath, new Date(0), new Date(0));
    const before = fs.statSync(statePath);
    const { adopted, snapshot, log, terminals } = await activateRegistry([{ ...row, startedAt }], ownedSnapshot(2_000_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(adopted).toHaveBeenCalledTimes(expectedAdoptions);
    if (expectedAdoptions === 0) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`Discarded registry row for pid ${row.pid}`));
      expect(fs.readFileSync(statePath, "utf8")).toBe(original);
      const after = fs.statSync(statePath);
      expect({ ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs })
        .toEqual({ ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
    } else {
      expect(adopted).toHaveBeenCalledExactlyOnceWith(terminals[0], row.sessionId, row.cwd);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")))
        .toEqual({ version: 2, terminals: [{ index: 0, sessionId: row.sessionId, cwd: row.cwd }] });
    }
  });

  it("releases unresolved terminal PID lookup at two seconds and retries rather than declaring foreign", async () => {
    const procs = ownedSnapshot();
    procs.set(row.pid, { pid: row.pid, ppid: 1, startedAtMs: null, command: "claude" });
    const unresolved = terminalWithPid(new Promise<number | undefined>(() => {}));
    const { read, snapshot, adopted, log } = await activateRegistry(
      [row], procs, [terminalWithPid(Promise.resolve(9000)), unresolved],
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(adopted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The two-second lookup has finished; only the retry timer remains.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(adopted).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([line]) => /foreign/i.test(line))).toHaveLength(0);
    expect(fs.existsSync(path.join(stateDir, "state.json"))).toBe(false);
  });

  it("adopts one owned row among 100 foreign rows with zero retries and one foreign-count log", async () => {
    const foreignRows = Array.from({ length: 100 }, (_, index) => ({ ...row, pid: 40_000 + index }));
    const procs = ownedSnapshot();
    for (const foreign of foreignRows) {
      procs.set(foreign.pid, { pid: foreign.pid, ppid: 1, startedAtMs: null, command: "claude" });
    }
    const { read, snapshot, adopted, log, terminals } = await activateRegistry([...foreignRows, row], procs);
    await vi.advanceTimersByTimeAsync(0);
    expect(adopted).toHaveBeenCalledExactlyOnceWith(terminals[0], row.sessionId, row.cwd);
    expect(adopted).toHaveReturnedWith(true);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")))
      .toEqual({ version: 2, terminals: [{ index: 0, sessionId: row.sessionId, cwd: row.cwd }] });
    const foreignLogs = () => log.mock.calls.filter(([line]) => /foreign/i.test(line));
    expect(foreignLogs()).toHaveLength(1);
    expect(foreignLogs()[0][0]).toMatch(/100.*foreign/i);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(foreignLogs()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    emitWatch();
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(foreignLogs()).toHaveLength(1);
  });
});
