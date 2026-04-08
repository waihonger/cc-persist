import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TerminalManager, isValidSessionName } from "../src/terminalManager";
import { window } from "vscode";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-stress-"));
}

function makeLog() {
  return window.createOutputChannel("test") as ReturnType<
    typeof window.createOutputChannel
  >;
}

function writeState(stateDir: string, state: unknown): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

describe("STRESS: State file with duplicate indices", () => {
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

  it("duplicate indices are deduplicated — first wins", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "session-a", index: 0 },
        { name: "session-b", index: 0 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();

    // Only first entry with index 0 is restored
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe("session-a");
  });

  it("duplicate index does not corrupt nextIndex calculation", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "alpha", index: 5 },
        { name: "beta", index: 5 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.restoreTerminals();

    const newT = tm.createTerminal("gamma");
    expect(tm.getIndex(newT)).toBe(6);
  });
});

describe("STRESS: State file with invalid indices", () => {
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

  it("negative index is filtered out by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "negative", index: -1 }],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("NaN index (null in JSON) is filtered out by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "nan-session", index: null }],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("huge index beyond MAX_SAFE_INTEGER is filtered out", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "huge", index: Number.MAX_SAFE_INTEGER + 1 }],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("large but valid index is accepted", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "large", index: 50000 }],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
  });

  it("fractional index is filtered out", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "frac", index: 1.5 }],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("valid entries survive alongside invalid ones", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "bad", index: -1 },
        { name: "good", index: 0 },
        { name: "also-bad", index: 1.5 },
        { name: "also-good", index: 3 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(2);
    expect(state.terminals[0].name).toBe("good");
    expect(state.terminals[1].name).toBe("also-good");
  });
});

describe("STRESS: Rapid create-then-close cycles", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("100 create-close cycles leave state empty but index at 100", () => {
    for (let i = 0; i < 100; i++) {
      const t = tm.createTerminal(`rapid-${i}`);
      tm.handleTerminalClosed(t);
    }
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);

    const next = tm.createTerminal("after-rapid");
    expect(tm.getIndex(next)).toBe(100);
  });

  it("terminal closed during shutdown preserves state on disk", () => {
    const t1 = tm.createTerminal("alive");
    tm.renameTerminal(t1, "alive");
    tm.saveState();
    // Simulate shutdown: setDisposing before terminal close events
    tm.setDisposing();
    tm.handleTerminalClosed(t1);
    // Terminal still tracked (early return skips cleanup)
    expect(tm.isTracked(t1)).toBe(true);
    // State on disk preserved
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
  });
});

describe("STRESS: Terminal name changes between create and save", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("renamed to unsafe name is silently skipped on save", () => {
    const t = tm.createTerminal("safe-name");
    (t as any).name = "'; rm -rf /";
    tm.saveState();

    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
    expect(tm.isTracked(t)).toBe(true);
  });

  it("renamed to empty string is silently dropped", () => {
    const t = tm.createTerminal("valid");
    (t as any).name = "";
    tm.saveState();
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("rename causes resume command to use new name", () => {
    const t = tm.createTerminal("original-session");
    tm.renameTerminal(t, "original-session");
    tm.renameTerminal(t, "renamed-session");
    tm.saveState();
    tm.disposeAll();

    const sendTextCalls: string[] = [];
    const origCreateTerminal = window.createTerminal;
    (window as any).createTerminal = (opts: any) => {
      const t = origCreateTerminal(opts);
      t.sendText = (text: string) => sendTextCalls.push(text);
      return t;
    };

    const tm2 = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm2.restoreTerminals();
    expect(sendTextCalls[0]).toContain("claude --dangerously-skip-permissions --resume 'renamed-session'");

    (window as any).createTerminal = origCreateTerminal;
    tm2.disposeAll();
  });
});

describe("STRESS: State file with wrong schema", () => {
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

  it("missing version field — treats as empty state", () => {
    writeState(stateDir, { terminals: [{ name: "test", index: 0 }] });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("version 2 — rejected, treated as empty", () => {
    writeState(stateDir, {
      version: 2,
      terminals: [{ name: "test", index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("terminals is an object, not array", () => {
    writeState(stateDir, {
      version: 1,
      terminals: { "0": { name: "test", index: 0 } },
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("terminal entries with missing fields — filtered out by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ foo: "bar" }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("undefined name in terminal entry — filtered out, no crash", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
    // restoreTerminals should not crash
    expect(() => tm.restoreTerminals()).not.toThrow();
  });

  it("null entry in terminals array — filtered out, no crash", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [null, { name: "valid", index: 1 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("valid");
  });

  it("primitive entries in terminals array — filtered out, no crash", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [42, "hello", true],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });
});

describe("STRESS: Concurrent saves", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("two rapid saves — second overwrites first", () => {
    const t1 = tm.createTerminal("first");
    tm.renameTerminal(t1, "first");
    tm.saveState();
    const t2 = tm.createTerminal("second");
    tm.renameTerminal(t2, "second");
    tm.saveState();

    const state = tm.loadState();
    expect(state.terminals).toHaveLength(2);
    expect(state.terminals.map((t) => t.name)).toEqual(["first", "second"]);
  });

  it("handleTerminalClosed triggers saveState — interleaving with manual save", () => {
    const t1 = tm.createTerminal("one");
    tm.renameTerminal(t1, "one");
    const t2 = tm.createTerminal("two");
    tm.renameTerminal(t2, "two");

    tm.handleTerminalClosed(t1);
    tm.saveState();

    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("two");
  });
});

describe("STRESS: Name validation edge cases", () => {
  it("rejects names with Unicode characters", () => {
    expect(isValidSessionName("会议")).toBe(false);
    expect(isValidSessionName("session-🚀")).toBe(false);
    expect(isValidSessionName("café")).toBe(false);
  });

  it("rejects names with newlines and control characters", () => {
    expect(isValidSessionName("line1\nline2")).toBe(false);
    expect(isValidSessionName("line1\rline2")).toBe(false);
    expect(isValidSessionName("tab\there")).toBe(false);
    expect(isValidSessionName("null\x00byte")).toBe(false);
  });

  it("rejects names with zero-width characters", () => {
    expect(isValidSessionName("session\u200Bname")).toBe(false);
    expect(isValidSessionName("test\u200Dname")).toBe(false);
    expect(isValidSessionName("test\u202Ename")).toBe(false);
  });

  it("boundary: exactly 64 chars accepted, 65 rejected", () => {
    expect(isValidSessionName("a".repeat(64))).toBe(true);
    expect(isValidSessionName("a".repeat(65))).toBe(false);
  });

  it("boundary: single char accepted (non-space)", () => {
    expect(isValidSessionName("a")).toBe(true);
    expect(isValidSessionName("-")).toBe(true);
  });

  it("rejects whitespace-only names", () => {
    expect(isValidSessionName("   ")).toBe(false);
    expect(isValidSessionName(" ")).toBe(false);
  });

  it("rejects names with leading/trailing spaces", () => {
    expect(isValidSessionName(" leading")).toBe(false);
    expect(isValidSessionName("trailing ")).toBe(false);
  });

  it("accepts names with internal spaces", () => {
    expect(isValidSessionName("war room")).toBe(true);
    expect(isValidSessionName("multi spaces")).toBe(true);
  });

  it("single quote is rejected", () => {
    expect(isValidSessionName("it's")).toBe(false);
  });

  it("backslash is rejected", () => {
    expect(isValidSessionName("path\\name")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidSessionName(undefined as any)).toBe(false);
    expect(isValidSessionName(null as any)).toBe(false);
    expect(isValidSessionName(42 as any)).toBe(false);
    expect(isValidSessionName({} as any)).toBe(false);
  });
});

describe("STRESS: restoreTerminals called twice (idempotency)", () => {
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

  it("double restore is idempotent — second call returns empty", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "session-one", index: 0 },
        { name: "session-two", index: 1 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const first = tm.restoreTerminals();
    const second = tm.restoreTerminals();

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
  });
});

describe("STRESS: handleTerminalClosed for untracked terminal", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("untracked terminal close is silently ignored", () => {
    const fakeTerminal = window.createTerminal({ name: "untracked" }) as any;
    expect(() => tm.handleTerminalClosed(fakeTerminal)).not.toThrow();
  });

  it("closing same terminal twice does not crash", () => {
    const t = tm.createTerminal("test");
    tm.handleTerminalClosed(t);
    expect(tm.isTracked(t)).toBe(false);
    expect(() => tm.handleTerminalClosed(t)).not.toThrow();
  });

  it("callback not fired for untracked terminal", () => {
    const callback = vi.fn();
    tm.setOnTerminalClosed(callback);
    const fakeTerminal = window.createTerminal({ name: "untracked" }) as any;
    tm.handleTerminalClosed(fakeTerminal);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("STRESS: createTerminal after restoreTerminals — index collision avoidance", () => {
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

  it("creates terminal after restoring non-contiguous indices", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "session-a", index: 0 },
        { name: "session-b", index: 5 },
        { name: "session-c", index: 3 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(3);

    // nextIndex should be max(0, 5, 3) + 1 = 6
    const newT = tm.createTerminal("new-session");
    expect(tm.getIndex(newT)).toBe(6);
  });
});

describe("STRESS: Disposing callback suppression", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("onTerminalClosed callback is NOT fired during disposing (early return)", () => {
    const callback = vi.fn();
    tm.setOnTerminalClosed(callback);
    const t = tm.createTerminal("test");
    tm.setDisposing();
    // handleTerminalClosed returns early when disposing — no cleanup, no callback
    tm.handleTerminalClosed(t);
    expect(callback).not.toHaveBeenCalled();
  });
});
