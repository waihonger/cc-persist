import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TerminalManager, isValidSessionName } from "../src/terminalManager";
import { _closeTerminal, _onDidCloseTerminal, TerminalExitReason, window } from "vscode";

const SID = "3fb057dc-8ed3-4b41-b3eb-8dde3fb1e02c";
const OTHER_SID = "a4e9761c-5ddc-48aa-a592-6c2bead472e9";

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
      expect(state.version).toBe(2);
      expect(state.terminals).toEqual([]);
    });

    it("writes parseable state atomically without leaving a temp file", () => {
      const terminal = tm.createTerminal();
      tm.adoptWithSessionId(terminal, SID);

      expect(tm.saveState()).toBe(true);
      expect(() => JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"))).not.toThrow();
      expect(fs.readdirSync(stateDir).filter((name) => /^state\.json.*\.tmp$/.test(name))).toEqual([]);
    });

    it("does not persist terminals before session ID capture", () => {
      const t1 = tm.createTerminal("unrenamed");
      const t2 = tm.createTerminal("also-unrenamed");
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(0);
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
    it("passes a blank ThemeIcon so tabs show no terminal icon", () => {
      const t = tm.createTerminal();
      expect((t as any).creationOptions.iconPath).toEqual({ id: "none" });
    });

    it("creates terminal with monotonically increasing index", () => {
      const t1 = tm.createTerminal("first");
      const t2 = tm.createTerminal("second");
      expect(tm.getIndex(t1)).toBe(0);
      expect(tm.getIndex(t2)).toBe(1);
    });

    it("creates terminal without capture environment variables", () => {
      const t = tm.createTerminal();
      const opts = (t as any).creationOptions;
      expect(opts.env).toBeUndefined();
    });

    it("does not set name on created terminal (Claude owns the title)", () => {
      const t = tm.createTerminal();
      const opts = (t as any).creationOptions;
      expect(opts.name).toBeUndefined();
    });

    it("does not set shell options or call sendText for a new terminal", () => {
      const sendText = vi.fn();
      const originalCreateTerminal = window.createTerminal;
      (window as any).createTerminal = (opts: any) => ({
        ...originalCreateTerminal(opts),
        sendText,
      });

      const terminal = tm.createTerminal();
      const opts = (terminal as any).creationOptions;
      expect(opts.shellPath).toBeUndefined();
      expect(opts.shellArgs).toBeUndefined();
      expect(sendText).not.toHaveBeenCalled();

      (window as any).createTerminal = originalCreateTerminal;
    });
  });

  describe("terminal tracking", () => {
    it("tracks terminals by index", () => {
      const t = tm.createTerminal("test");
      expect(tm.getIndex(t)).toBe(0);
      expect(tm.isTracked(t)).toBe(true);
    });

  });

  describe("PID-lane adoption", () => {
    it("adoptWithSessionId assigns a fresh index and saves an unnamed terminal", () => {
      tm.createTerminal();
      const terminal = window.createTerminal({ name: "plain terminal" });

      expect(tm.adoptWithSessionId(terminal, SID)).toBe(true);
      expect(tm.getIndex(terminal)).toBe(1);
      expect(tm.loadState().terminals).toEqual([{ index: 1, sessionId: SID }]);
    });

    it("adoptWithSessionId reuses a tracked terminal index and overwrites its session ID", () => {
      const terminal = tm.createTerminal();
      const index = tm.getIndex(terminal);

      expect(tm.adoptWithSessionId(terminal, SID)).toBe(true);
      expect(tm.adoptWithSessionId(terminal, OTHER_SID)).toBe(true);
      expect(tm.getIndex(terminal)).toBe(index);
      expect(tm.loadState().terminals).toEqual([{ index: 0, sessionId: OTHER_SID }]);
    });

    it("adoptWithSessionId rejects an invalid session ID without saving", () => {
      const terminal = window.createTerminal({ name: "plain terminal" });
      const saveState = vi.spyOn(tm, "saveState");

      expect(tm.adoptWithSessionId(terminal, "not-a-session-id")).toBe(false);
      expect(tm.isTracked(terminal)).toBe(false);
      expect(saveState).not.toHaveBeenCalled();
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
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        terminals: [
          { index: 0, sessionId: SID, name: "first" },
          { index: 1, sessionId: OTHER_SID, name: "second" },
        ],
      }));
      const [t1] = tm.restoreTerminals();
      tm.saveState();
      // exitStatus.reason = User (default in mock)
      tm.handleTerminalClosed(t1);
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0].name).toBe("second");
    });

    it.each([
      ["Shutdown", TerminalExitReason.Shutdown],
      ["Process", TerminalExitReason.Process],
      ["Unknown", TerminalExitReason.Unknown],
      ["Extension", TerminalExitReason.Extension],
      ["undefined exitStatus", undefined],
    ])("preserves byte-identical state for %s", (_label, reason) => {
      tm.registerEventHandlers({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);
      const t = tm.createTerminal();
      tm.adoptWithSessionId(t, SID);
      tm.saveState();
      const before = fs.readFileSync(path.join(stateDir, "state.json"));

      if (reason === undefined) {
        (t as any).exitStatus = undefined;
        _onDidCloseTerminal.fire(t);
      } else {
        _closeTerminal(t, reason);
      }

      expect(tm.isTracked(t)).toBe(true);
      expect(fs.readFileSync(path.join(stateDir, "state.json"))).toEqual(before);
    });

    it("prunes and saves for close reason User", () => {
      tm.registerEventHandlers({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);
      const t = tm.createTerminal();
      tm.adoptWithSessionId(t, SID);
      tm.saveState();

      _closeTerminal(t, TerminalExitReason.User);

      expect(tm.isTracked(t)).toBe(false);
      expect(tm.loadState().terminals).toEqual([]);
    });
  });

  describe("restore command delivery", () => {
    function restoreWithShell(shellPath: string | undefined) {
      const sendText = vi.fn();
      const originalCreateTerminal = window.createTerminal;
      (window as any).createTerminal = (opts: any) => ({
        ...originalCreateTerminal(opts),
        sendText,
      });
      const manager = new TerminalManager(
        stateDir,
        signalBaseDir,
        startDir,
        makeLog(),
        undefined,
        shellPath,
      );
      const terminals = manager.restoreTerminals();
      (window as any).createTerminal = originalCreateTerminal;
      return { manager, sendText, terminals };
    }

    beforeEach(() => {
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        terminals: [{ index: 0, sessionId: SID }],
      }));
    });

    it("falls back to immediate sendText for an unsupported shell", () => {
      const { manager, sendText, terminals } = restoreWithShell("/usr/bin/fish");
      expect(terminals).toHaveLength(1);
      expect((terminals[0] as any).creationOptions.shellPath).toBeUndefined();
      expect((terminals[0] as any).creationOptions.shellArgs).toBeUndefined();
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(`claude --dangerously-skip-permissions --resume '${SID}'`);
      manager.disposeAll();
    });

    it("falls back to immediate sendText when shellPath is undefined", () => {
      const { manager, sendText, terminals } = restoreWithShell(undefined);
      expect(terminals).toHaveLength(1);
      expect((terminals[0] as any).creationOptions.shellPath).toBeUndefined();
      expect((terminals[0] as any).creationOptions.shellArgs).toBeUndefined();
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(`claude --dangerously-skip-permissions --resume '${SID}'`);
      manager.disposeAll();
    });

    it("uses a login command shell and quoted exec target for bash", () => {
      const { manager, sendText, terminals } = restoreWithShell("/bin/bash");
      expect(terminals).toHaveLength(1);
      const opts = (terminals[0] as any).creationOptions;
      expect(opts.shellPath).toBe("/bin/bash");
      expect(opts.shellArgs[0]).toBe("-lc");
      expect(opts.shellArgs[1]).toBe(`claude --dangerously-skip-permissions --resume '${SID}'; exec '/bin/bash' -il`);
      expect(sendText).not.toHaveBeenCalled();
      manager.disposeAll();
    });

    it("falls back to immediate sendText when shellPath contains a single quote", () => {
      const { manager, sendText, terminals } = restoreWithShell("/opt/we'ird/zsh");
      expect(terminals).toHaveLength(1);
      expect((terminals[0] as any).creationOptions.shellPath).toBeUndefined();
      expect((terminals[0] as any).creationOptions.shellArgs).toBeUndefined();
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(`claude --dangerously-skip-permissions --resume '${SID}'`);
      manager.disposeAll();
    });
  });

  describe("restore", () => {
    it("creates terminals from saved state", () => {
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        terminals: [
          { index: 0, sessionId: SID, name: "warroom" },
          { index: 1, sessionId: OTHER_SID, name: "alan" },
        ],
      }));

      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog());
      const terminals = tm2.restoreTerminals();
      expect(terminals).toHaveLength(2);
      for (const t of terminals) expect((t as any).creationOptions.iconPath).toEqual({ id: "none" });
      expect(tm2.getSessionName(terminals[0])).toBe("warroom");
      expect(tm2.getSessionName(terminals[1])).toBe("alan");
      tm2.disposeAll();
    });

    it("bakes the claude --resume command into zsh shellArgs", () => {
      const t = tm.createTerminal();
      tm.adoptWithSessionId(t, SID);
      tm.saveState();
      tm.disposeAll();

      const tm2 = new TerminalManager(stateDir, signalBaseDir, startDir, makeLog(), undefined, "/bin/zsh");
      const [terminal] = tm2.restoreTerminals();
      const opts = (terminal as any).creationOptions;
      expect(opts.shellPath).toBe("/bin/zsh");
      expect(opts.shellArgs[0]).toBe("-lc");
      expect(opts.shellArgs[1]).toContain(`claude --dangerously-skip-permissions --resume '${SID}'`);
      expect(opts.shellArgs[1]).toMatch(/; exec '\/bin\/zsh' -il$/);

      tm2.disposeAll();
    });

    it("preserves indices on restore", () => {
      const t1 = tm.createTerminal();
      const t2 = tm.createTerminal();
      tm.adoptWithSessionId(t1, SID);
      tm.adoptWithSessionId(t2, OTHER_SID);
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
    it("saveState uses stored session name over terminal.name", () => {
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        terminals: [{ index: 0, sessionId: SID, name: "warroom" }],
      }));
      tm.restoreTerminals();
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals[0].name).toBe("warroom");
    });

    it("terminal without a session ID or stored name is not persisted", () => {
      tm.createTerminal("my-session");
      tm.saveState();
      const state = tm.loadState();
      expect(state.terminals).toHaveLength(0);
    });

    it("restore populates session name map", () => {
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        terminals: [{ index: 0, sessionId: SID, name: "warroom" }],
      }));
      const terminals = tm.restoreTerminals();
      expect(tm.getSessionName(terminals[0])).toBe("warroom");
    });

    it("handleTerminalClosed cleans up session name", () => {
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({
        version: 2,
        terminals: [{ index: 0, sessionId: SID, name: "warroom" }],
      }));
      const [t] = tm.restoreTerminals();
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
