import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/** Prefix used for the ephemeral signal directory in $TMPDIR. */
const SIGNAL_DIR_PREFIX = "dtach-persist";

export function sanitizeName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  sanitized = sanitized.replace(/^-+/, "");
  sanitized = sanitized.slice(0, 32);
  return sanitized || "vscode";
}

export function resolveWorkspaceId(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const fsPath = folders[0].uri.fsPath;
    const folderName = path.basename(fsPath) || "vscode";
    const hash = crypto
      .createHash("sha256")
      .update(fsPath)
      .digest("hex")
      .slice(0, 6);
    const sanitized = sanitizeName(folderName).slice(0, 25);
    return `${sanitized}-${hash}`;
  }
  return "vscode";
}

/** Persistent state dir (~/.cc-persist/<workspaceId>/) — survives reboot. */
export function resolveStateDir(): string {
  return path.join(os.homedir(), ".cc-persist", resolveWorkspaceId());
}

/** Ephemeral signal base dir ($TMPDIR/dtach-persist/<workspaceId>/) — for shell hooks. */
export function resolveSignalBaseDir(): string {
  return path.join(os.tmpdir(), SIGNAL_DIR_PREFIX, resolveWorkspaceId());
}

/** Signal files subdirectory. */
export function signalDir(baseDir: string): string {
  return path.join(baseDir, "signals");
}

export function resolveStartDirectory(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}
