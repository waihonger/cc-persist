import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TerminalManager } from "../src/terminalManager";
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
