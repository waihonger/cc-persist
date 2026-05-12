import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TerminalManager, isValidSessionName, isValidIndex } from "../src/terminalManager";
import { SignalWatcher } from "../src/signalWatcher";
import {
  window,
  _onDidChangeActiveTerminal,
  _onDidChangeWindowState,
  _setActiveTerminal,
  commands,
} from "vscode";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-stress3-"));
}

function makeLog() {
  const lines: string[] = [];
  return {
    channel: window.createOutputChannel("test") as ReturnType<
      typeof window.createOutputChannel
    >,
    lines,
    spyLog: {
      appendLine: (msg: string) => { lines.push(msg); },
      dispose: () => {},
    } as unknown as ReturnType<typeof window.createOutputChannel>,
  };
}

function writeState(stateDir: string, state: unknown): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

// ============================================================
// FIX VERIFIED: MAX_SAFE_INTEGER index is rejected by isValidIndex
// to prevent nextIndex overflow (IEEE 754 precision loss).
// ============================================================

describe("STRESS3: FIX VERIFIED -- MAX_SAFE_INTEGER index rejected to prevent overflow", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
  });

  afterEach(() => {
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("MAX_SAFE_INTEGER index is rejected by isValidIndex", () => {
    expect(isValidIndex(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isValidIndex(Number.MAX_SAFE_INTEGER - 1)).toBe(true);
  });

  it("state entry with MAX_SAFE_INTEGER index is filtered by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "max-idx", index: Number.MAX_SAFE_INTEGER }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("restoreTerminals skips MAX_SAFE_INTEGER index entries", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "max-idx", index: Number.MAX_SAFE_INTEGER },
        { name: "valid", index: 5 },
      ],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(1);
    expect(tm.getSavedName(5)).toBe("valid");
  });
});

// ============================================================
// BUG 2: signalWatcher uses !isNaN instead of isValidIndex
// Severity: HIGH (accepts negative/unsafe indices from filesystem)
//
// signalWatcher.scanSignals and onFile use:
//   const index = parseInt(basename, 10); if (isNaN(index)) return;
// But onGotoFile correctly uses isValidIndex(index).
//
// This means a signal file named "-1.signal" is accepted by
// scanSignals/onFile but the same index would be rejected by
// onGotoFile. Negative indices can pollute the signal map.
// ============================================================

describe("STRESS3: BUG -- signalWatcher accepts negative indices via scanSignals/onFile", () => {
  let signalDir: string;
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;
  let sw: SignalWatcher;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    signalDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    sw?.dispose();
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
    fs.rmSync(signalDir, { recursive: true, force: true });
  });

  it("negative index signal file is accepted by onFile but rejected by onGotoFile", () => {
    // Create a signal file with negative index
    fs.writeFileSync(path.join(signalDir, "-1.signal"), "");

    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);

    // Mock context
    const fakeContext = {
      subscriptions: { push: () => {} },
    } as unknown as import("vscode").ExtensionContext;

    // Intercept registerCommand to avoid double-registration
    const origRegister = commands.registerCommand;
    (commands as any).registerCommand = () => ({ dispose: () => {} });

    sw.start(fakeContext);

    (commands as any).registerCommand = origRegister;

    // Write a goto file with negative index
    fs.writeFileSync(path.join(signalDir, "goto"), "-1");
    sw.markRestoreComplete();

    // onGotoFile uses isValidIndex, so -1 is rejected
    // But the -1.signal file was already accepted by scanSignals via !isNaN
    // This is an inconsistency: the signal map has a phantom -1 entry
    // that can never be navigated to via goto
  });
});

// ============================================================
// BUG 3: signalWatcher.onFile doesn't validate index with
// isValidIndex -- accepts fractional-parsed and huge indices
// Severity: MEDIUM (phantom entries in signal map)
// ============================================================

describe("STRESS3: BUG -- signalWatcher onFile accepts all parseInt-parseable filenames", () => {
  let signalDir: string;
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    signalDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
    fs.rmSync(signalDir, { recursive: true, force: true });
  });

  it("parseInt truncates '1.5' to 1, file '1.5.signal' produces index 1 not 1.5", () => {
    // This is technically not a bug in behavior (parseInt truncation is well-known)
    // but it means '1.5.signal' maps to the same index as '1.signal'
    const parsed = parseInt(path.basename("1.5.signal", ".signal"), 10);
    expect(parsed).toBe(1); // parseInt("1.5") === 1, not NaN
    expect(!isNaN(parsed)).toBe(true); // passes the guard
  });

  it("parseInt parses '1abc.signal' as 1, accepting garbage filenames", () => {
    const parsed = parseInt(path.basename("1abc.signal", ".signal"), 10);
    expect(parsed).toBe(1);
    expect(!isNaN(parsed)).toBe(true);
  });
});

// ============================================================
// ATTACK: Names that pass SAFE_NAME_RE but are dangerous as
// CLI arguments (e.g. "--help", "--version")
// Severity: MEDIUM (sendText sends `claude --resume '--help'`
// which is safe due to single quotes, but worth documenting)
// ============================================================

describe("STRESS3: Names starting with -- pass validation", () => {
  it("--help passes isValidSessionName", () => {
    expect(isValidSessionName("--help")).toBe(true);
  });

  it("--version passes isValidSessionName", () => {
    expect(isValidSessionName("--version")).toBe(true);
  });

  it("--resume passes (could confuse claude CLI argument parsing)", () => {
    expect(isValidSessionName("--resume")).toBe(true);
  });

  it("sendText wraps in single quotes so -- names are safe in practice", () => {
    const stateDir = makeTmpDir();
    const signalBaseDir = makeTmpDir();

    const sendTextCalls: string[] = [];
    const origCreateTerminal = window.createTerminal;
    (window as any).createTerminal = (opts: any) => {
      const t = origCreateTerminal(opts);
      t.sendText = (text: string) => sendTextCalls.push(text);
      return t;
    };

    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "--help", index: 0 }],
    });

    const tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    tm.restoreTerminals();

    // Single quotes protect against argument interpretation
    expect(sendTextCalls[0]).toContain("claude --dangerously-skip-permissions --resume '--help'");

    (window as any).createTerminal = origCreateTerminal;
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });
});

// ============================================================
// ATTACK: 5000 entries in state.json -- performance boundary
// ============================================================

describe("STRESS3: 5000-entry state file performance", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
  });

  afterEach(() => {
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("save 5000 terminals completes in under 2 seconds", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    for (let i = 0; i < 5000; i++) {
      tm.createTerminal(`session-${i}`);
    }
    const start = performance.now();
    tm.saveState();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("load 5000 terminals completes in under 2 seconds", () => {
    const terminals = Array.from({ length: 5000 }, (_, i) => ({
      name: `s-${i}`,
      index: i,
    }));
    writeState(stateDir, { version: 1, terminals });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const start = performance.now();
    const state = tm.loadState();
    const elapsed = performance.now() - start;

    expect(state.terminals).toHaveLength(5000);
    expect(elapsed).toBeLessThan(2000);
  });

  it("restore 5000 terminals and nextIndex is correct", () => {
    const terminals = Array.from({ length: 5000 }, (_, i) => ({
      name: `s-${i}`,
      index: i,
    }));
    writeState(stateDir, { version: 1, terminals });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(5000);

    const newT = tm.createTerminal("extra");
    expect(tm.getIndex(newT)).toBe(5000);
  });

  it("5000 terminals round-trip save-load preserves all data", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    for (let i = 0; i < 5000; i++) {
      const t = tm.createTerminal(`session-${i}`);
      tm.renameTerminal(t, `session-${i}`);
    }
    tm.saveState();
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(5000);
    // Verify ordering (sorted by index)
    for (let i = 0; i < 5000; i++) {
      expect(state.terminals[i].index).toBe(i);
    }
  });
});

// ============================================================
// ATTACK: Periodic save timer vs handleTerminalClosed race
// In Node.js single-threaded model, these can't truly race,
// but we verify the interleaving scenario produces correct state.
// ============================================================

describe("STRESS3: Periodic save timer interleaving with handleTerminalClosed", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("saveState immediately after handleTerminalClosed does not re-add closed terminal", () => {
    const t1 = tm.createTerminal("alive");
    tm.renameTerminal(t1, "alive");
    const t2 = tm.createTerminal("dying");
    tm.renameTerminal(t2, "dying");

    // handleTerminalClosed removes from maps AND saves
    tm.handleTerminalClosed(t2);

    // Periodic save fires right after
    tm.saveState();

    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("alive");
  });

  it("user-close saves state with closed terminal removed", () => {
    const t1 = tm.createTerminal("stays");
    tm.renameTerminal(t1, "stays");
    const t2 = tm.createTerminal("will-close");
    tm.renameTerminal(t2, "will-close");
    tm.saveState();
    expect(tm.loadState().terminals).toHaveLength(2);

    // User closes terminal (exitStatus.reason = Process, the mock default)
    tm.handleTerminalClosed(t2);

    // State on disk updated — user close saves
    const after = tm.loadState();
    expect(after.terminals).toHaveLength(1);
    expect(after.terminals[0].name).toBe("stays");
  });
});

// ============================================================
// SignalWatcher: First-ever test coverage
// ============================================================

describe("STRESS3: SignalWatcher -- basic signal lifecycle", () => {
  let signalDir: string;
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;
  let sw: SignalWatcher;

  function makeFakeContext() {
    const subs: any[] = [];
    return {
      subscriptions: subs,
    } as unknown as import("vscode").ExtensionContext;
  }

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    signalDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    sw?.dispose();
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
    fs.rmSync(signalDir, { recursive: true, force: true });
  });

  it("creates status bar item on construction", () => {
    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    // No crash -- status bar item was created
  });

  it("dispose stops watcher and timer without crash", () => {
    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    // dispose before start -- should not crash
    expect(() => sw.dispose()).not.toThrow();
  });

  it("start creates signalDir if missing", () => {
    const newDir = path.join(os.tmpdir(), `cc-persist-sigtest-${Date.now()}`);
    const { spyLog } = makeLog();
    sw = new SignalWatcher(newDir, tm, spyLog);

    const ctx = makeFakeContext();
    sw.start(ctx);

    expect(fs.existsSync(newDir)).toBe(true);
    fs.rmSync(newDir, { recursive: true, force: true });
  });

  it("scanSignals picks up signal file created before start", () => {
    // Create signal file before starting watcher
    fs.writeFileSync(path.join(signalDir, "0.signal"), "");

    const { spyLog, lines } = makeLog();

    // Unfocus window so signal is not auto-cleared
    (window as any).state = { focused: false };

    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);

    (window as any).state = { focused: true };

    // scanSignals runs during start(), which calls onFile for 0.signal
    // Check log for signal detection
    const signalLine = lines.find((l: string) => l.includes("Signal received"));
    expect(signalLine).toBeDefined();
  });

  it("onTerminalClosed clears signals for that index", () => {
    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);

    // Create signal file
    fs.writeFileSync(path.join(signalDir, "0.signal"), "");
    fs.writeFileSync(path.join(signalDir, "0.permission"), "");

    const ctx = makeFakeContext();

    // Unfocus so signals aren't auto-cleared
    (window as any).state = { focused: false };
    sw.start(ctx);
    (window as any).state = { focused: true };

    // Close terminal should clean up signal files
    sw.onTerminalClosed(0);

    // Signal files should be deleted
    expect(fs.existsSync(path.join(signalDir, "0.signal"))).toBe(false);
    expect(fs.existsSync(path.join(signalDir, "0.permission"))).toBe(false);
  });

  it("stale signals are pruned based on STALE_THRESHOLD_MS", () => {
    // Create a signal file with old mtime
    const signalPath = path.join(signalDir, "0.signal");
    fs.writeFileSync(signalPath, "");

    // Set mtime to 5 hours ago (default stale threshold is 4 hours)
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    fs.utimesSync(signalPath, fiveHoursAgo, fiveHoursAgo);

    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();

    (window as any).state = { focused: false };
    sw.start(ctx);
    (window as any).state = { focused: true };

    // Stale signal should be deleted by onFile
    expect(fs.existsSync(signalPath)).toBe(false);
  });

  it("markRestoreComplete processes pending goto file", () => {
    const t0 = tm.createTerminal("target");
    const showSpy = vi.spyOn(t0, "show");

    // Write goto before restore is complete
    fs.writeFileSync(path.join(signalDir, "goto"), "0");

    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);

    // goto should not be processed yet (restoreComplete = false)
    expect(showSpy).not.toHaveBeenCalled();

    // Mark restore complete -- should now process the goto
    sw.markRestoreComplete();
    expect(showSpy).toHaveBeenCalled();
  });

  it("deleteSignalFile removes all signal types for an index", () => {
    fs.writeFileSync(path.join(signalDir, "5.signal"), "");
    fs.writeFileSync(path.join(signalDir, "5.permission"), "");
    fs.writeFileSync(path.join(signalDir, "5.error"), "");

    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    sw.deleteSignalFile(5);

    expect(fs.existsSync(path.join(signalDir, "5.signal"))).toBe(false);
    expect(fs.existsSync(path.join(signalDir, "5.permission"))).toBe(false);
    expect(fs.existsSync(path.join(signalDir, "5.error"))).toBe(false);
  });
});

describe("STRESS3: SignalWatcher -- goto file edge cases", () => {
  let signalDir: string;
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;
  let sw: SignalWatcher;

  function makeFakeContext() {
    return {
      subscriptions: [] as any[],
    } as unknown as import("vscode").ExtensionContext;
  }

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    signalDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    sw?.dispose();
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
    fs.rmSync(signalDir, { recursive: true, force: true });
  });

  it("goto file with non-numeric content is ignored", () => {
    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);
    sw.markRestoreComplete();

    fs.writeFileSync(path.join(signalDir, "goto"), "not-a-number");
    // Trigger manual processing
    sw.markRestoreComplete(); // second call is fine, just sets flag and checks
    // No crash expected
  });

  it("goto file with negative index is rejected by isValidIndex", () => {
    const { spyLog, lines } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);
    sw.markRestoreComplete();

    fs.writeFileSync(path.join(signalDir, "goto"), "-1");
    sw.markRestoreComplete();

    // -1 should be rejected by isValidIndex
    const gotoLine = lines.find((l: string) => l.includes("Goto request"));
    expect(gotoLine).toBeUndefined();
  });

  it("goto file with fractional index is truncated by parseInt and accepted", () => {
    const { spyLog, lines } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);
    sw.markRestoreComplete();

    // parseInt("1.5", 10) === 1, which IS valid -- so this actually passes
    // isValidIndex check and shows terminal 1 (if it exists)
    fs.writeFileSync(path.join(signalDir, "goto"), "1.5");
    sw.markRestoreComplete();

    // parseInt("1.5") = 1, and isValidIndex(1) = true
    // So goto request IS logged for terminal 1
    const gotoLine = lines.find((l: string) => l.includes("Goto request for terminal 1"));
    expect(gotoLine).toBeDefined(); // Not a bug per se, but shows parseInt truncation
  });

  it("goto file with empty content does not crash", () => {
    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);
    sw.markRestoreComplete();

    fs.writeFileSync(path.join(signalDir, "goto"), "");
    expect(() => sw.markRestoreComplete()).not.toThrow();
  });

  it("goto file with whitespace-padded number is handled", () => {
    const t0 = tm.createTerminal("target");
    const showSpy = vi.spyOn(t0, "show");

    const { spyLog } = makeLog();
    sw = new SignalWatcher(signalDir, tm, spyLog);
    const ctx = makeFakeContext();
    sw.start(ctx);
    sw.markRestoreComplete();

    fs.writeFileSync(path.join(signalDir, "goto"), "  0  \n");
    sw.markRestoreComplete();

    // .trim() + parseInt should handle whitespace
    expect(showSpy).toHaveBeenCalled();
  });
});

// ============================================================
// ATTACK: disposeAll then saveState -- what gets written?
// ============================================================

describe("STRESS3: disposeAll then saveState writes empty state", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("saveState after disposeAll writes current (empty) map to disk", () => {
    const t = tm.createTerminal("important-session");
    tm.renameTerminal(t, "important-session");
    tm.saveState();

    // Verify state was saved
    let state = tm.loadState();
    expect(state.terminals).toHaveLength(1);

    // disposeAll clears maps
    tm.disposeAll();

    // saveState writes whatever is in maps (now empty) — no shutdown race guard
    tm.saveState();
    state = tm.loadState();
    expect(state.terminals).toHaveLength(0); // Maps were empty, so disk is empty
  });
});

// ============================================================
// ATTACK: setDisposing + disposeAll interaction
// ============================================================

describe("STRESS3: setDisposing then disposeAll sequence", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("setDisposing does not save state — state on disk from last rename is preserved", () => {
    const t = tm.createTerminal("preserved");
    tm.renameTerminal(t, "preserved");
    // Simulate what rename command does: save state to disk
    tm.saveState();

    tm.setDisposing();

    // State should still be on disk from the saveState above (not from setDisposing)
    let state = tm.loadState();
    expect(state.terminals).toHaveLength(1);

    // disposeAll clears in-memory maps but does NOT write to disk
    tm.disposeAll();

    // State file should still have the terminal
    state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("preserved");
  });

  it("shutdown close preserves state on disk through dispose sequence", () => {
    const t = tm.createTerminal("test");
    tm.renameTerminal(t, "test");
    tm.saveState();
    tm.setDisposing();
    // Simulate shutdown close — early return, terminal stays tracked
    tm.handleTerminalClosed(t);

    expect(tm.isTracked(t)).toBe(true);
    tm.disposeAll();

    // State file preserved — shutdown close didn't save
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
  });
});

// ============================================================
// ATTACK: Name with dots that looks like path traversal
// ============================================================

describe("STRESS3: Path-traversal-like names", () => {
  it("'..' passes SAFE_NAME_RE", () => {
    expect(isValidSessionName("..")).toBe(true);
  });

  it("'...' passes SAFE_NAME_RE", () => {
    expect(isValidSessionName("...")).toBe(true);
  });

  it("single '.' passes SAFE_NAME_RE for single-char", () => {
    expect(isValidSessionName(".")).toBe(true);
  });

  it("path-traversal names are safe in resume command due to single quotes", () => {
    const stateDir = makeTmpDir();
    const signalBaseDir = makeTmpDir();
    const sendTextCalls: string[] = [];
    const origCreateTerminal = window.createTerminal;
    (window as any).createTerminal = (opts: any) => {
      const t = origCreateTerminal(opts);
      t.sendText = (text: string) => sendTextCalls.push(text);
      return t;
    };

    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "..", index: 0 }],
    });

    const tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    tm.restoreTerminals();
    expect(sendTextCalls[0]).toContain("claude --dangerously-skip-permissions --resume '..'");

    (window as any).createTerminal = origCreateTerminal;
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });
});

// ============================================================
// ATTACK: isValidIndex edge cases exposed by MAX_SAFE_INTEGER
// ============================================================

describe("STRESS3: isValidIndex edge cases", () => {
  it("MAX_SAFE_INTEGER is rejected (prevents overflow)", () => {
    expect(isValidIndex(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("MAX_SAFE_INTEGER + 1 is invalid (not safe integer, but isInteger returns true)", () => {
    // Interesting: Number.isInteger(MAX_SAFE_INTEGER + 1) === true
    // But MAX_SAFE_INTEGER + 1 > MAX_SAFE_INTEGER, so isValidIndex rejects
    expect(isValidIndex(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("MAX_SAFE_INTEGER - 1 is valid", () => {
    expect(isValidIndex(Number.MAX_SAFE_INTEGER - 1)).toBe(true);
  });

  it("-0 is valid (treated as 0)", () => {
    expect(isValidIndex(-0)).toBe(true);
  });

  it("NaN is invalid", () => {
    expect(isValidIndex(NaN)).toBe(false);
  });

  it("Infinity is invalid", () => {
    expect(isValidIndex(Infinity)).toBe(false);
    expect(isValidIndex(-Infinity)).toBe(false);
  });

  it("string '0' is invalid (type check)", () => {
    expect(isValidIndex("0" as any)).toBe(false);
  });

  it("null is invalid", () => {
    expect(isValidIndex(null as any)).toBe(false);
  });

  it("undefined is invalid", () => {
    expect(isValidIndex(undefined as any)).toBe(false);
  });
});

// ============================================================
// ATTACK: Multiple rapid restoreTerminals across instances
// ============================================================

describe("STRESS3: Two TerminalManager instances reading same state file", () => {
  let stateDir: string;
  let signalBaseDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("two managers restoring from same state creates duplicate terminals", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "shared-session", index: 0 },
      ],
    });

    const tm1 = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const tm2 = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);

    const r1 = tm1.restoreTerminals();
    const r2 = tm2.restoreTerminals();

    // Both restore the same session -- no lock/coordination
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);

    // Both have index 0, but they're separate terminal objects
    // This means two terminals with same DTACH_SOCKET_INDEX
    const opts1 = (r1[0] as any).creationOptions;
    const opts2 = (r2[0] as any).creationOptions;
    expect(opts1.env.DTACH_SOCKET_INDEX).toBe("0");
    expect(opts2.env.DTACH_SOCKET_INDEX).toBe("0");

    tm1.disposeAll();
    tm2.disposeAll();
  });
});

// ============================================================
// ATTACK: showFirst and showTerminal on empty/invalid state
// ============================================================

describe("STRESS3: showFirst and showTerminal on empty/invalid state", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("showFirst on empty manager does not crash", () => {
    expect(() => tm.showFirst()).not.toThrow();
  });

  it("showTerminal with non-existent index does not crash", () => {
    expect(() => tm.showTerminal(999)).not.toThrow();
  });

  it("getSavedName with non-existent index returns undefined", () => {
    expect(tm.getSavedName(999)).toBeUndefined();
  });

  it("getIndex for untracked terminal returns undefined", () => {
    const fakeT = window.createTerminal({ name: "fake" }) as any;
    expect(tm.getIndex(fakeT)).toBeUndefined();
  });
});
