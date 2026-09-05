import * as vscode from "vscode";
import { resolveStateDir, resolveSignalBaseDir, resolveStartDirectory, signalDir } from "./config";
import { findOwningShellPid, snapshotProcesses } from "./pidResolver";
import { SignalWatcher } from "./signalWatcher";
import { TerminalManager, isValidSessionName, DEFAULT_RESUME_FLAGS } from "./terminalManager";

let terminalManager: TerminalManager | undefined;

async function adoptPidSession(claudePid: number, sid: string, cwd?: string): Promise<boolean> {
  if (!terminalManager) return false;
  const terminals = vscode.window.terminals;
  const pidPairs = await Promise.all(terminals.map(async (terminal) => [terminal, await terminal.processId] as const));
  const shellPids = new Set(
    pidPairs
      .filter(([, pid]) => typeof pid === "number")
      .map(([, pid]) => pid as number),
  );
  const procs = await snapshotProcesses();
  const shellPid = findOwningShellPid(claudePid, procs, shellPids);
  if (shellPid === null) return false;
  const owner = pidPairs.find(([, pid]) => pid === shellPid)?.[0];
  if (!owner) return false;
  if (!vscode.window.terminals.includes(owner) || owner.exitStatus !== undefined) return false;
  return terminalManager.adoptWithSessionId(owner, sid, cwd);
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const log = vscode.window.createOutputChannel("cc-persist");
  context.subscriptions.push(log);
  log.appendLine("Activating cc-persist");

  const config = vscode.workspace.getConfiguration("cc-persist");
  const resumeFlags = config.get<string>("resumeFlags", DEFAULT_RESUME_FLAGS);
  const staleSignalHours = config.get<number>("staleSignalHours", 4);
  const closeRogueTerminals = config.get<boolean>("closeRogueTerminals", true);

  const stateDir = resolveStateDir();
  const signalBaseDir = resolveSignalBaseDir();
  const startDir = resolveStartDirectory();
  const sigDir = signalDir(signalBaseDir);

  context.environmentVariableCollection.replace("DTACH_SIGNAL_DIR", sigDir);
  context.environmentVariableCollection.description = "cc-persist: session tracking for all terminals";

  log.appendLine(`State dir: ${stateDir}`);
  log.appendLine(`Signal dir: ${sigDir}`);
  log.appendLine(`Start dir: ${startDir}`);

  terminalManager = new TerminalManager(stateDir, signalBaseDir, startDir, log, resumeFlags, vscode.env.shell);
  try {
    terminalManager.writeWorkspaceMetadata();
  } catch (err) {
    log.appendLine(`Failed to write workspace metadata: ${err}`);
  }
  terminalManager.registerEventHandlers(context);

  // Signal watcher for Claude Code task completion notifications
  const signalWatcher = new SignalWatcher(
    sigDir,
    terminalManager,
    log,
    (index, sid, cwd) => terminalManager!.setSessionId(index, sid, cwd),
    staleSignalHours,
    adoptPidSession,
  );
  signalWatcher.start(context);
  context.subscriptions.push({ dispose: () => signalWatcher.dispose() });

  // Connect terminal close → signal cleanup
  terminalManager.setOnTerminalClosed((index) => signalWatcher.onTerminalClosed(index));

  // New terminal command
  context.subscriptions.push(
    vscode.commands.registerCommand("cc-persist.newTerminal", () =>
      terminalManager!.createTerminal(),
    ),
  );

  // Rename terminal command
  context.subscriptions.push(
    vscode.commands.registerCommand("cc-persist.renameTerminal", async () => {
      const terminal = vscode.window.activeTerminal;
      if (!terminal) {
        vscode.window.showWarningMessage("No active terminal to rename");
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: "Session display name (optional; session ID is used for resume)",
        placeHolder: "e.g. warroom",
        validateInput: (value) => {
          if (!value) return "Name is required";
          return isValidSessionName(value) ? null : "Invalid name — use letters, numbers, dashes, underscores, dots, spaces";
        },
      });
      if (!name) return;

      const stored = terminalManager!.renameTerminal(terminal, name);
      if (!stored) return;
      if (stored !== name) {
        vscode.window.showInformationMessage(`Name "${name}" already in use; saved as "${stored}"`);
      }
      terminal.sendText(`/rename ${stored}`);
      terminalManager!.saveState();
      log.appendLine(`User renamed terminal to: ${stored}`);
    }),
  );

  // Restore saved sessions
  const state = terminalManager.loadState();
  if (state.terminals.length > 0) {
    log.appendLine(`Found ${state.terminals.length} saved session(s) — queued for restore`);

    // Close any pre-existing rogue non-managed terminals
    if (closeRogueTerminals) {
      for (const t of vscode.window.terminals) {
        if (!terminalManager.isTracked(t)) {
          log.appendLine("Closing pre-existing rogue terminal");
          t.dispose();
        }
      }
    }

    let restored = false;
    const doRestore = () => {
      if (restored) return;
      restored = true;
      rogueWatcher.dispose();
      const terminals = terminalManager!.restoreTerminals();
      terminalManager!.showFirst();
      signalWatcher.markRestoreComplete();
      log.appendLine(`Restore complete — ${terminals.length} terminal(s)`);
      if (terminals.length > 0) {
        vscode.window.showInformationMessage(`Restored ${terminals.length} Claude terminal(s)`);
      }
    };

    // Restore as soon as VS Code's rogue default terminal appears — fastest path.
    // Fallback timeout in case no rogue terminal is created.
    const rogueWatcher = vscode.window.onDidOpenTerminal((t) => {
      if (!terminalManager!.isTracked(t)) {
        log.appendLine("Rogue terminal detected — triggering restore");
        if (closeRogueTerminals) t.dispose();
        doRestore();
      }
    });
    setTimeout(doRestore, 150);
  } else {
    signalWatcher.markRestoreComplete();
  }

  log.appendLine("cc-persist activated");
}

export function deactivate(): void {}
