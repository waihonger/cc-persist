import * as vscode from "vscode";
import { resolveStateDir, resolveSignalBaseDir, resolveStartDirectory } from "./config";
import { findOwningShellPid, isLiveClaudePid, type ProcEntry } from "./pidResolver";
import { RegistryWatcher, type PidSessionOutcome } from "./registryWatcher";
import { readRegistry, resolveSessionsDir } from "./sessionRegistry";
import { TerminalManager, DEFAULT_RESUME_FLAGS } from "./terminalManager";

let terminalManager: TerminalManager | undefined;
const pidToTerminal = new Map<number, vscode.Terminal>();

async function resolveTerminalPid(terminal: vscode.Terminal): Promise<number | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2000);
    });
    return await Promise.race([terminal.processId, deadline]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function adoptPidSession(
  claudePid: number,
  sid: string,
  cwd: string | undefined,
  processSnapshot: Promise<Map<number, ProcEntry>>,
  startedAt: number | undefined,
): Promise<PidSessionOutcome> {
  if (!terminalManager) return "retry";
  const procs = await processSnapshot;
  if (procs.size === 0) return "retry";
  if (!isLiveClaudePid(claudePid, procs, startedAt)) return "discard";
  const terminals = vscode.window.terminals;
  const pidPairs = await Promise.all(terminals.map(async (terminal) => [terminal, await resolveTerminalPid(terminal)] as const));
  const hasUnresolvedTerminal = pidPairs.some(([, pid]) => typeof pid !== "number");
  const shellPids = new Set(
    pidPairs
      .filter(([, pid]) => typeof pid === "number")
      .map(([, pid]) => pid as number),
  );
  const shellPid = findOwningShellPid(claudePid, procs, shellPids);
  if (shellPid === null) return hasUnresolvedTerminal ? "retry" : "foreign";
  const owner = pidPairs.find(([, pid]) => pid === shellPid)?.[0];
  if (!owner) return "retry";
  if (!vscode.window.terminals.includes(owner) || owner.exitStatus !== undefined) return "retry";
  if (!terminalManager.adoptWithSessionId(owner, sid, cwd)) return "retry";
  for (const [pid, terminal] of pidToTerminal) {
    if (terminal === owner) pidToTerminal.delete(pid);
  }
  pidToTerminal.set(claudePid, owner);
  return "adopted";
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  context.environmentVariableCollection.clear();
  context.environmentVariableCollection.description = "";
  const log = vscode.window.createOutputChannel("cc-persist");
  context.subscriptions.push(log);
  log.appendLine("Activating cc-persist");

  const config = vscode.workspace.getConfiguration("cc-persist");
  const resumeFlags = config.get<string>("resumeFlags", DEFAULT_RESUME_FLAGS);
  const closeRogueTerminals = config.get<boolean>("closeRogueTerminals", true);

  const stateDir = resolveStateDir();
  const signalBaseDir = resolveSignalBaseDir();
  const startDir = resolveStartDirectory();

  log.appendLine(`State dir: ${stateDir}`);
  log.appendLine(`Start dir: ${startDir}`);

  terminalManager = new TerminalManager(stateDir, signalBaseDir, startDir, log, resumeFlags, vscode.env.shell);
  try {
    terminalManager.writeWorkspaceMetadata();
  } catch (err) {
    log.appendLine(`Failed to write workspace metadata: ${err}`);
  }
  terminalManager.registerEventHandlers(context);

  // Capture live session IDs from Claude Code's registry after restore completes.
  const registryWatcher = new RegistryWatcher(resolveSessionsDir(), log, adoptPidSession, readRegistry);
  registryWatcher.onStatusChange = (pid, from, to, row) => {
    const enabled = vscode.workspace.getConfiguration("cc-persist").get<boolean>("notifications", false);
    if (!enabled || from !== "busy" || (to !== "idle" && to !== "waiting")) return;
    const terminal = pidToTerminal.get(pid);
    if (!terminal || !terminalManager?.isTracked(terminal) || terminal === vscode.window.activeTerminal) return;
    const label = row.name ?? terminalManager.getIndex(terminal);
    const notification = to === "idle"
      ? vscode.window.showInformationMessage(`${label}: done`, "Show")
      : vscode.window.showWarningMessage(`${label}: needs input`, "Show");
    void notification.then((choice) => {
      if (choice === "Show") terminal.show();
    }, (error: unknown) => {
      log.appendLine(`Failed to show session notification: ${error}`);
    });
  };
  registryWatcher.start();
  context.subscriptions.push(
    { dispose: () => { registryWatcher.dispose(); pidToTerminal.clear(); } },
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [pid, terminal] of pidToTerminal) {
        if (terminal === closed) pidToTerminal.delete(pid);
      }
    }),
  );

  // New terminal command
  context.subscriptions.push(
    vscode.commands.registerCommand("cc-persist.newTerminal", () =>
      terminalManager!.createTerminal(),
    ),
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
      registryWatcher.markRestoreComplete();
      log.appendLine(`Restore complete — ${terminals.length} terminal(s)`);
      if (terminals.length > 0) {
        vscode.window.showInformationMessage(`Restored ${terminals.length} Claude terminal(s)`);
      }
    };

    // Restore as soon as VS Code's rogue default terminal appears for the fastest path.
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
    registryWatcher.markRestoreComplete();
  }

  log.appendLine("cc-persist activated");
}

export function deactivate(): void {}
