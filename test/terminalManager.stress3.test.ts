import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TerminalManager, isValidSessionName, isValidIndex } from "../src/terminalManager";
import {
  window,
  _onDidChangeActiveTerminal,
  _onDidChangeWindowState,
  _setActiveTerminal,
  _closeTerminal,
  commands,
  TerminalExitReason,
} from "vscode";

const SID = "3fb057dc-8ed3-4b41-b3eb-8dde3fb1e02c";
const OTHER_SID = "a4e9761c-5ddc-48aa-a592-6c2bead472e9";

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
      version: 2,
      terminals: [{ name: "max-idx", index: Number.MAX_SAFE_INTEGER, sessionId: SID }],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const state = tm.loadState();
    expect(state.terminals).toHaveLength(0);
  });

  it("restoreTerminals skips MAX_SAFE_INTEGER index entries", () => {
    writeState(stateDir, {
      version: 2,
      terminals: [
        { name: "max-idx", index: Number.MAX_SAFE_INTEGER, sessionId: SID },
        { name: "valid", index: 5, sessionId: SID },
      ],
    });
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(1);
    expect(tm.getSessionName(restored[0])).toBe("valid");
  });
});
// ============================================================
// Names that are valid display metadata even though they resemble CLI flags.
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
      (tm as any).indexToSessionId.set(i, SID);
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
      sessionId: SID,
    }));
    writeState(stateDir, { version: 2, terminals });

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
      sessionId: SID,
    }));
    writeState(stateDir, { version: 2, terminals });

    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    const restored = tm.restoreTerminals();
    expect(restored).toHaveLength(5000);

    const newT = tm.createTerminal("extra");
    expect(tm.getIndex(newT)).toBe(5000);
  });

  it("5000 terminals round-trip save-load preserves all data", () => {
    tm = new TerminalManager(stateDir, signalBaseDir, "/tmp", makeLog().channel);
    for (let i = 0; i < 5000; i++) {
      tm.createTerminal(`session-${i}`);
      (tm as any).indexToSessionId.set(i, SID);
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
    tm.adoptWithSessionId(t1, SID);
    const t2 = tm.createTerminal("dying");
    tm.adoptWithSessionId(t2, OTHER_SID);

    // handleTerminalClosed removes from maps AND saves
    tm.handleTerminalClosed(t2);

    // Periodic save fires right after
    tm.saveState();

    const state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].sessionId).toBe(SID);
  });

  it("user-close saves state with closed terminal removed", () => {
    const t1 = tm.createTerminal("stays");
    tm.adoptWithSessionId(t1, SID);
    const t2 = tm.createTerminal("will-close");
    tm.adoptWithSessionId(t2, OTHER_SID);
    tm.saveState();
    expect(tm.loadState().terminals).toHaveLength(2);

    // User closes terminal (exitStatus.reason = User, the mock default)
    tm.handleTerminalClosed(t2);

    // State on disk updated — user close saves
    const after = tm.loadState();
    expect(after.terminals).toHaveLength(1);
    expect(after.terminals[0].sessionId).toBe(SID);
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
    tm.adoptWithSessionId(t, SID);
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
// ATTACK: Shutdown close + disposeAll interaction
// ============================================================

describe("STRESS3: Shutdown close then disposeAll sequence", () => {
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

  it("disposeAll after a shutdown close preserves the last saved state", () => {
    const t = tm.createTerminal("preserved");
    tm.adoptWithSessionId(t, SID);
    tm.saveState();
    tm.registerEventHandlers({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);

    _closeTerminal(t, TerminalExitReason.Shutdown);

    let state = tm.loadState();
    expect(state.terminals).toHaveLength(1);

    tm.disposeAll();

    state = tm.loadState();
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0].sessionId).toBe(SID);
  });

  it("shutdown close preserves state on disk through dispose sequence", () => {
    const t = tm.createTerminal("test");
    tm.adoptWithSessionId(t, SID);
    tm.saveState();
    tm.registerEventHandlers({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);
    _closeTerminal(t, TerminalExitReason.Shutdown);

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
      version: 2,
      terminals: [
        { name: "shared-session", index: 0, sessionId: SID },
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
    expect(tm1.getIndex(r1[0])).toBe(0);
    expect(tm2.getIndex(r2[0])).toBe(0);

    tm1.disposeAll();
    tm2.disposeAll();
  });
});

// ============================================================
// ATTACK: showFirst on empty/invalid state
// ============================================================

describe("STRESS3: showFirst on empty/invalid state", () => {
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

  it("getIndex for untracked terminal returns undefined", () => {
    const fakeT = window.createTerminal({ name: "fake" }) as any;
    expect(tm.getIndex(fakeT)).toBeUndefined();
  });
});
