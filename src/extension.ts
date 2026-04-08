import * as vscode from "vscode";
import { resolveStateDir, resolveSignalBaseDir, resolveStartDirectory, signalDir } from "./config";
import { SignalWatcher } from "./signalWatcher";
import { TerminalManager, isValidSessionName, CLEANUP_DELAY_MS } from "./terminalManager";

let terminalManager: TerminalManager | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const log = vscode.window.createOutputChannel("cc-persist");
  context.subscriptions.push(log);
  log.appendLine("Activating cc-persist");

  const stateDir = resolveStateDir();
  const signalBaseDir = resolveSignalBaseDir();
  const startDir = resolveStartDirectory();
  const sigDir = signalDir(signalBaseDir);

  log.appendLine(`State dir: ${stateDir}`);
  log.appendLine(`Signal dir: ${sigDir}`);
  log.appendLine(`Start dir: ${startDir}`);

  terminalManager = new TerminalManager(stateDir, signalBaseDir, startDir, log, CLEANUP_DELAY_MS);
  try {
    terminalManager.writeWorkspaceMetadata();
  } catch (err) {
    log.appendLine(`Failed to write workspace metadata: ${err}`);
  }
  terminalManager.registerEventHandlers(context);

  // Set disposing flag early via subscription cleanup — fires before/alongside
  // terminal close events during shutdown, giving us a second chance to set the
  // flag before handleTerminalClosed runs.
  context.subscriptions.push({
    dispose: () => {
      terminalManager?.setDisposing();
    },
  });

  // Signal watcher for Claude Code task completion notifications
  const signalWatcher = new SignalWatcher(sigDir, terminalManager, log);
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
        prompt: "Session name (used for claude --resume)",
        placeHolder: "e.g. warroom",
        validateInput: (value) => {
          if (!value) return "Name is required";
          return isValidSessionName(value) ? null : "Invalid name — use letters, numbers, dashes, underscores, dots, spaces";
        },
      });
      if (!name) return;

      terminalManager!.renameTerminal(terminal, name);
      terminal.sendText(`/rename ${name}`);
      vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name });
      terminalManager!.saveState();
      log.appendLine(`User renamed terminal to: ${name}`);
    }),
  );

  // Restore saved sessions
  const state = terminalManager.loadState();
  if (state.terminals.length > 0) {
    log.appendLine(`Found ${state.terminals.length} saved session(s) — queued for restore`);

    // Close any pre-existing rogue non-managed terminals
    for (const t of vscode.window.terminals) {
      if (!terminalManager.isTracked(t)) {
        log.appendLine("Closing pre-existing rogue terminal");
        t.dispose();
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
        log.appendLine("Closing rogue terminal — triggering restore");
        t.dispose();
        doRestore();
      }
    });
    setTimeout(doRestore, 150);
  } else {
    signalWatcher.markRestoreComplete();
  }

  log.appendLine("cc-persist activated");
}

export function deactivate(): void {
  terminalManager?.setDisposing();
}
