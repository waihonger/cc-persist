import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SignalWatcher } from "../src/signalWatcher";
import { parseSidPayload, TerminalManager } from "../src/terminalManager";
import { _attachShellIntegration, window } from "vscode";

const SID = "3fb057dc-8ed3-4b41-b3eb-8dde3fb1e02c";
const OTHER_SID = "a4e9761c-5ddc-48aa-a592-6c2bead472e9";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-v2-"));
}

function makeLog() {
  const lines: string[] = [];
  return {
    lines,
    channel: {
      appendLine: (line: string) => lines.push(line),
      dispose: () => {},
    } as unknown as ReturnType<typeof window.createOutputChannel>,
  };
}

function writeState(stateDir: string, state: unknown): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

function captureShellCommands(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = window.createTerminal;
  (window as any).createTerminal = (options: unknown) => {
    const terminal = original(options);
    _attachShellIntegration(terminal, (text: string) => calls.push(text));
    return terminal;
  };
  return {
    calls,
    restore: () => { (window as any).createTerminal = original; },
  };
}

describe("session ID persistence", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    vi.useRealTimers();
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("setSessionId stores valid UUID and persists v2 state", () => {
    tm.createTerminal();
    tm.setSessionId(0, SID);

    expect(tm.loadState()).toEqual({
      version: 2,
      terminals: [{ index: 0, sessionId: SID }],
    });
  });

  it("setSessionId rejects malformed session ids", () => {
    const { lines } = makeLog();
    tm.disposeAll();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", {
      appendLine: (line: string) => lines.push(line),
      dispose: () => {},
    } as unknown as ReturnType<typeof window.createOutputChannel>);
    tm.createTerminal();
    tm.setSessionId(0, "not-a-uuid; rm -rf /");
    tm.saveState();

    expect(tm.loadState().terminals).toEqual([]);
    expect(lines.some((line) => line.includes("Ignoring invalid session ID"))).toBe(true);
  });

  it("setSessionId ignores untracked indexes and does not overwrite state", () => {
    writeState(stateDir, {
      version: 2,
      terminals: [{ index: 0, sessionId: OTHER_SID }],
    });
    const before = fs.readFileSync(path.join(stateDir, "state.json"), "utf8");

    tm.setSessionId(3, SID); // no terminal tracked at index 3 — stale .sid scenario

    expect(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).toBe(before);
    expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: OTHER_SID }]);
  });

  it("saveState persists unnamed terminals that have a sessionId", () => {
    tm.createTerminal();
    tm.setSessionId(0, SID);
    tm.saveState();

    expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: SID }]);
  });

  it("loadState migrates v1 name-only entries", () => {
    writeState(stateDir, { version: 1, terminals: [{ name: "legacy", index: 4 }] });

    expect(tm.loadState()).toEqual({
      version: 2,
      terminals: [{ index: 4, name: "legacy" }],
    });
  });

  it("loadState accepts v2 entries and rejects entries with neither sid nor name", () => {
    writeState(stateDir, {
      version: 2,
      terminals: [
        { index: 0, sessionId: SID },
        { index: 1, name: "named" },
        { index: 2 },
        { index: 3, sessionId: "invalid", name: "fallback" },
      ],
    });

    expect(tm.loadState().terminals).toEqual([
      { index: 0, sessionId: SID },
      { index: 1, name: "named" },
      { index: 3, name: "fallback" },
    ]);
  });

  it("restore prefers sessionId over name in the resume command", () => {
    writeState(stateDir, {
      version: 2,
      terminals: [{ index: 0, sessionId: SID, name: "display-name" }],
    });
    const capture = captureShellCommands();

    tm.restoreTerminals();

    expect(capture.calls[0]).toContain(`--resume '${SID}'`);
    expect(capture.calls[0]).not.toContain("display-name");
    capture.restore();
  });

  it("restore falls back to name for legacy entries", () => {
    writeState(stateDir, { version: 1, terminals: [{ index: 0, name: "legacy" }] });
    const capture = captureShellCommands();

    tm.restoreTerminals();

    expect(capture.calls[0]).toContain("--resume 'legacy'");
    capture.restore();
  });

  it("restore command contains configured resume flags", () => {
    tm.disposeAll();
    writeState(stateDir, { version: 2, terminals: [{ index: 0, sessionId: SID }] });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel, 0, "--model opus --verbose");
    const capture = captureShellCommands();

    tm.restoreTerminals();

    expect(capture.calls[0]).toContain("claude --model opus --verbose --resume");
    capture.restore();
  });

  it("invalid resume flags fall back to default", () => {
    tm.disposeAll();
    writeState(stateDir, { version: 2, terminals: [{ index: 0, sessionId: OTHER_SID }] });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel, 0, "--verbose; touch /tmp/pwned");
    const capture = captureShellCommands();

    tm.restoreTerminals();

    expect(capture.calls[0]).toContain("claude --dangerously-skip-permissions --resume");
    expect(capture.calls[0]).not.toContain("touch");
    capture.restore();
  });

  it("sendCommand falls back to sendText when shell integration never appears", () => {
    vi.useFakeTimers();
    writeState(stateDir, { version: 2, terminals: [{ index: 0, sessionId: SID }] });
    const calls: string[] = [];
    const original = window.createTerminal;
    (window as any).createTerminal = (options: unknown) => {
      const terminal = original(options);
      terminal.sendText = (text: string) => calls.push(text);
      return terminal;
    };

    tm.restoreTerminals();
    vi.advanceTimersByTime(2999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls[0]).toContain(`--resume '${SID}'`);

    (window as any).createTerminal = original;
  });

  it("parseSidPayload accepts legacy UUIDs and validated JSON payloads", () => {
    expect(parseSidPayload(`${SID}\n`)).toEqual({ sessionId: SID });
    expect(parseSidPayload(JSON.stringify({ sessionId: SID, cwd: "/tmp/project" }))).toEqual({
      sessionId: SID,
      cwd: "/tmp/project",
    });
    expect(parseSidPayload(JSON.stringify({ sessionId: SID, cwd: "relative/project" }))).toEqual({
      sessionId: SID,
    });
    expect(parseSidPayload(JSON.stringify({ sessionId: "bad", cwd: "/tmp/project" }))).toBeNull();
    expect(parseSidPayload("not JSON or a UUID")).toBeNull();
  });

  it("state round-trip preserves the captured working directory", () => {
    tm.createTerminal();
    tm.setSessionId(0, SID, "/tmp/project");

    expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: SID, cwd: "/tmp/project" }]);
  });

  it("a later capture without cwd clears the previously captured directory", () => {
    tm.createTerminal();
    tm.setSessionId(0, SID, "/tmp/project");
    tm.setSessionId(0, OTHER_SID);

    expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: OTHER_SID }]);
  });

  it("restore creates a terminal in its saved working directory when it exists", () => {
    const savedCwd = makeTmpDir();
    writeState(stateDir, {
      version: 2,
      terminals: [{ index: 0, sessionId: SID, cwd: savedCwd }],
    });

    const [terminal] = tm.restoreTerminals();

    expect((terminal as any).creationOptions.cwd).toBe(savedCwd);
    fs.rmSync(savedCwd, { recursive: true, force: true });
  });

  it("restore falls back to the start directory when the saved working directory is gone", () => {
    const removedCwd = makeTmpDir();
    fs.rmSync(removedCwd, { recursive: true, force: true });
    writeState(stateDir, {
      version: 2,
      terminals: [{ index: 0, sessionId: SID, cwd: removedCwd }],
    });

    const [terminal] = tm.restoreTerminals();

    expect((terminal as any).creationOptions.cwd).toBe("/tmp");
  });
});

describe("SignalWatcher session IDs", () => {
  async function flushPidLane(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  function makeWatcherFixture() {
    const stateDir = makeTmpDir();
    const signalBaseDir = makeTmpDir();
    const signalDir = makeTmpDir();
    const tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const callback = vi.fn(() => true);
    const pidCallback = vi.fn(async () => true);
    const show = vi.fn();
    const originalCreateStatusBarItem = window.createStatusBarItem;
    (window as any).createStatusBarItem = () => ({
      text: "",
      tooltip: "",
      command: "",
      backgroundColor: undefined,
      show,
      hide: vi.fn(),
      dispose: vi.fn(),
    });
    const watcher = new SignalWatcher(signalDir, tm, makeLog().channel, callback, 4, pidCallback);
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    return {
      signalDir, callback, pidCallback, show, watcher, context,
      cleanup: () => {
        watcher.dispose();
        tm.disposeAll();
        (window as any).createStatusBarItem = originalCreateStatusBarItem;
        fs.rmSync(stateDir, { recursive: true, force: true });
        fs.rmSync(signalBaseDir, { recursive: true, force: true });
        fs.rmSync(signalDir, { recursive: true, force: true });
      },
    };
  }

  it(".sid ingestion deferred until restore completes, then file deleted, not shown in status bar", () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "7.sid");
    fs.writeFileSync(sidPath, `${SID}\n`);

    f.watcher.start(f.context);
    expect(f.callback).not.toHaveBeenCalled(); // restore pending — must not ingest yet
    expect(fs.existsSync(sidPath)).toBe(true);

    f.watcher.markRestoreComplete();
    expect(f.callback).toHaveBeenCalledWith(7, SID);
    expect(fs.existsSync(sidPath)).toBe(false);
    expect(f.show).not.toHaveBeenCalled();

    f.cleanup();
  });

  it("sid file kept for retry when persistence fails, discarded after the window", () => {
    vi.useFakeTimers();
    const f = makeWatcherFixture();
    f.callback.mockReturnValue(false); // persistence failing (untracked index / disk error)
    const sidPath = path.join(f.signalDir, "5.sid");
    fs.writeFileSync(sidPath, `${SID}\n`);

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    expect(f.callback).toHaveBeenCalledWith(5, SID);
    expect(fs.existsSync(sidPath)).toBe(true); // kept — next poll retries

    const past = new Date(Date.now() - 61_000);
    fs.utimesSync(sidPath, past, past); // sat unprocessed past the retry window
    vi.advanceTimersByTime(10_000);

    expect(fs.existsSync(sidPath)).toBe(false); // discarded as garbage

    vi.useRealTimers();
    f.cleanup();
  });

  it("partial .sid file is kept and ingested once the writer finishes", () => {
    vi.useFakeTimers();
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "3.sid");
    fs.writeFileSync(sidPath, ""); // truncate-then-write race: watcher sees empty file

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    expect(f.callback).not.toHaveBeenCalled();
    expect(fs.existsSync(sidPath)).toBe(true); // NOT deleted — writer may still be mid-write

    fs.writeFileSync(sidPath, `${SID}\n`);
    vi.advanceTimersByTime(10_000); // next poll picks it up

    expect(f.callback).toHaveBeenCalledWith(3, SID);
    expect(fs.existsSync(sidPath)).toBe(false);

    vi.useRealTimers();
    f.cleanup();
  });

  it("pid sid file invokes the resolver callback and is unlinked on success", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, `${SID}\n`);

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenCalledWith(4321, SID);
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("pid sid file is retained after callback failure, then discarded after the retry window", async () => {
    vi.useFakeTimers();
    const f = makeWatcherFixture();
    f.pidCallback.mockResolvedValue(false);
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, `${SID}\n`);

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    await flushPidLane();
    expect(fs.existsSync(sidPath)).toBe(true);

    const past = new Date(Date.now() - 61_000);
    fs.utimesSync(sidPath, past, past);
    vi.advanceTimersByTime(10_000);
    await flushPidLane();

    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
    vi.useRealTimers();
  });

  it("malformed pid sid filename never invokes the resolver callback", async () => {
    const f = makeWatcherFixture();
    fs.writeFileSync(path.join(f.signalDir, "pid-abc.sid"), `${SID}\n`);

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).not.toHaveBeenCalled();
    f.cleanup();
  });

  it("pid sid in-flight guard prevents a second scan from resolving the same file", async () => {
    vi.useFakeTimers();
    const f = makeWatcherFixture();
    let finish: ((done: boolean) => void) | undefined;
    f.pidCallback.mockImplementation(() => new Promise<boolean>((resolve) => {
      finish = resolve;
    }));
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, `${SID}\n`);

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    expect(f.pidCallback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(f.pidCallback).toHaveBeenCalledTimes(1);

    finish?.(true);
    await flushPidLane();
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
    vi.useRealTimers();
  });

  it("stale pid sid file is removed without invoking the resolver callback", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, `${SID}\n`);
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(sidPath, stale, stale);

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).not.toHaveBeenCalled();
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("pid sid JSON payload passes its cwd to the resolver callback", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID, cwd: "/tmp/project" }));

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenCalledWith(4321, SID, "/tmp/project");
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("legacy index sid JSON payload passes its cwd to the persistence callback", () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "7.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID, cwd: "/tmp/project" }));

    f.watcher.markRestoreComplete();

    expect(f.callback).toHaveBeenCalledWith(7, SID, "/tmp/project");
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("pid sid file rewritten during resolution is left for the next scan", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    let finish: ((done: boolean) => void) | undefined;
    f.pidCallback
      .mockImplementationOnce(() => {
        fs.writeFileSync(sidPath, JSON.stringify({ sessionId: OTHER_SID, cwd: "/tmp/second" }));
        return new Promise<boolean>((resolve) => { finish = resolve; });
      })
      .mockResolvedValueOnce(true);
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID, cwd: "/tmp/first" }));

    f.watcher.markRestoreComplete();
    finish?.(true);
    await flushPidLane();

    expect(fs.existsSync(sidPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidPath, "utf8"))).toEqual({
      sessionId: OTHER_SID,
      cwd: "/tmp/second",
    });

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenNthCalledWith(2, 4321, OTHER_SID, "/tmp/second");
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });
});
