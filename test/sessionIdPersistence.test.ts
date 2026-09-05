import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SignalWatcher } from "../src/signalWatcher";
import { parseSidPayload, TerminalManager } from "../src/terminalManager";
import { window } from "vscode";

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

function expectZshRestore(terminal: unknown, command: string): string {
  const options = (terminal as any).creationOptions;
  expect(options.shellPath).toBe("/bin/zsh");
  expect(options.shellArgs[0]).toBe("-lc");
  expect(options.shellArgs[1]).toContain(command);
  expect(options.shellArgs[1]).toMatch(/; exec '\/bin\/zsh' -il$/);
  return options.shellArgs[1];
}

describe("session ID persistence", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel, undefined, "/bin/zsh");
  });

  afterEach(() => {
    vi.useRealTimers();
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("saveState persists unnamed terminals that have a sessionId", () => {
    const terminal = tm.createTerminal();
    tm.adoptWithSessionId(terminal, SID);
    tm.saveState();

    expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: SID }]);
  });

  it("v1 state loads as empty", () => {
    tm.disposeAll();
    const log = makeLog();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", log.channel, undefined, "/bin/zsh");
    writeState(stateDir, { version: 1, terminals: [{ name: "legacy", index: 4 }] });

    expect(tm.loadState()).toEqual({
      version: 2,
      terminals: [],
    });
    expect(log.lines).toContain(
      "1 legacy name-only entries ignored (run scripts/migrate-name-only.py before upgrading)",
    );
  });

  it("loadState drops v2 entries without a valid sessionId", () => {
    tm.disposeAll();
    const log = makeLog();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", log.channel, undefined, "/bin/zsh");
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
    ]);
    expect(log.lines).toContain(
      "3 legacy name-only entries ignored (run scripts/migrate-name-only.py before upgrading)",
    );
  });

  it("restore prefers sessionId over name in the resume command", () => {
    writeState(stateDir, {
      version: 2,
      terminals: [{ index: 0, sessionId: SID, name: "display-name" }],
    });
    const [terminal] = tm.restoreTerminals();

    const command = expectZshRestore(
      terminal,
      `claude --dangerously-skip-permissions --resume '${SID}'`,
    );
    expect(command).not.toContain("display-name");
  });

  it("restore command contains configured resume flags", () => {
    tm.disposeAll();
    writeState(stateDir, { version: 2, terminals: [{ index: 0, sessionId: SID }] });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel, "--model opus --verbose", "/bin/zsh");

    const [terminal] = tm.restoreTerminals();

    expectZshRestore(terminal, `claude --model opus --verbose --resume '${SID}'`);
  });

  it("invalid resume flags fall back to default", () => {
    tm.disposeAll();
    writeState(stateDir, { version: 2, terminals: [{ index: 0, sessionId: OTHER_SID }] });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel, "--verbose; touch /tmp/pwned", "/bin/zsh");

    const [terminal] = tm.restoreTerminals();

    const command = expectZshRestore(
      terminal,
      `claude --dangerously-skip-permissions --resume '${OTHER_SID}'`,
    );
    expect(command).not.toContain("touch");
  });

  it("parseSidPayload accepts validated JSON payloads only", () => {
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
    const terminal = tm.createTerminal();
    tm.adoptWithSessionId(terminal, SID, "/tmp/project");

    expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: SID, cwd: "/tmp/project" }]);
  });

  it("a later capture without cwd clears the previously captured directory", () => {
    const terminal = tm.createTerminal();
    tm.adoptWithSessionId(terminal, SID, "/tmp/project");
    tm.adoptWithSessionId(terminal, OTHER_SID);

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
    for (let index = 0; index < 10; index++) await Promise.resolve();
  }

  function makeWatcherFixture() {
    const stateDir = makeTmpDir();
    const signalBaseDir = makeTmpDir();
    const signalDir = makeTmpDir();
    const tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const log = makeLog();
    const pidCallback = vi.fn(async () => "adopted" as const);
    const snapshot = vi.fn(async () => new Map());
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
    const watcher = new SignalWatcher(signalDir, tm, log.channel, 4, pidCallback, snapshot);
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    return {
      signalDir, pidCallback, snapshot, show, watcher, context, lines: log.lines,
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

  it("pid sid file invokes the resolver callback and is unlinked on success", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID }));

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenCalledWith(
      4321,
      SID,
      undefined,
      expect.any(Number),
      expect.any(Promise),
    );
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("a ten-minute-old pid sid file is still resolved and adopted", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(sidPath, old, old);

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenCalledWith(
      4321,
      SID,
      undefined,
      expect.any(Number),
      expect.any(Promise),
    );
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("retry leaves the pid sid file and does not log a discard", async () => {
    const f = makeWatcherFixture();
    f.pidCallback.mockResolvedValue("retry");
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID }));

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(fs.existsSync(sidPath)).toBe(true);
    expect(f.lines.some((line) => /discard/i.test(line))).toBe(false);
    f.cleanup();
  });

  it("discard unlinks the pid sid file", async () => {
    const f = makeWatcherFixture();
    f.pidCallback.mockResolvedValue("discard");
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID }));

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(fs.existsSync(sidPath)).toBe(false);
    expect(f.lines).toContain("Discarded session ID file for pid 4321 (not a live Claude process): pid-4321.sid");
    f.cleanup();
  });

  it("retry gives up after 30 minutes", async () => {
    const f = makeWatcherFixture();
    f.pidCallback.mockResolvedValue("retry");
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID }));
    const old = new Date(Date.now() - 30 * 60 * 1000 - 1);
    fs.utimesSync(sidPath, old, old);

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(fs.existsSync(sidPath)).toBe(false);
    expect(f.lines).toContain("Gave up on session ID file after 30 minutes: pid-4321.sid");
    f.cleanup();
  });

  it("malformed pid sid filename never invokes the resolver callback", async () => {
    const f = makeWatcherFixture();
    fs.writeFileSync(path.join(f.signalDir, "pid-abc.sid"), JSON.stringify({ sessionId: SID }));

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).not.toHaveBeenCalled();
    f.cleanup();
  });

  it("pid sid in-flight guard prevents a second scan from resolving the same file", async () => {
    vi.useFakeTimers();
    const f = makeWatcherFixture();
    let finish: ((outcome: "adopted") => void) | undefined;
    f.pidCallback.mockImplementation(() => new Promise<"adopted">((resolve) => {
      finish = resolve;
    }));
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID }));

    f.watcher.start(f.context);
    f.watcher.markRestoreComplete();
    expect(f.pidCallback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(f.pidCallback).toHaveBeenCalledTimes(1);

    finish?.("adopted");
    await flushPidLane();
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
    vi.useRealTimers();
  });

  it("pid sid JSON payload passes its cwd to the resolver callback", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID, cwd: "/tmp/project" }));

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenCalledWith(
      4321,
      SID,
      "/tmp/project",
      expect.any(Number),
      expect.any(Promise),
    );
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("pid sid file rewritten during resolution is left for the next scan", async () => {
    const f = makeWatcherFixture();
    const sidPath = path.join(f.signalDir, "pid-4321.sid");
    let finish: ((outcome: "adopted") => void) | undefined;
    f.pidCallback
      .mockImplementationOnce(() => {
        fs.writeFileSync(sidPath, JSON.stringify({ sessionId: OTHER_SID, cwd: "/tmp/second" }));
        return new Promise<"adopted">((resolve) => { finish = resolve; });
      })
      .mockResolvedValueOnce("adopted");
    fs.writeFileSync(sidPath, JSON.stringify({ sessionId: SID, cwd: "/tmp/first" }));

    f.watcher.markRestoreComplete();
    finish?.("adopted");
    await flushPidLane();

    expect(fs.existsSync(sidPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidPath, "utf8"))).toEqual({
      sessionId: OTHER_SID,
      cwd: "/tmp/second",
    });

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenNthCalledWith(
      2,
      4321,
      OTHER_SID,
      "/tmp/second",
      expect.any(Number),
      expect.any(Promise),
    );
    expect(fs.existsSync(sidPath)).toBe(false);
    f.cleanup();
  });

  it("takes one process snapshot for three pid files in one poll pass", async () => {
    const f = makeWatcherFixture();
    for (const pid of [4321, 4322, 4323]) {
      fs.writeFileSync(
        path.join(f.signalDir, `pid-${pid}.sid`),
        JSON.stringify({ sessionId: SID }),
      );
    }

    f.watcher.markRestoreComplete();
    await flushPidLane();

    expect(f.pidCallback).toHaveBeenCalledTimes(3);
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    const processPromises = f.pidCallback.mock.calls.map((call) => call[4]);
    expect(processPromises[1]).toBe(processPromises[0]);
    expect(processPromises[2]).toBe(processPromises[0]);
    f.cleanup();
  });
});
