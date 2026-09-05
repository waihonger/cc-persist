# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Instead of keeping processes alive (the old dtach approach), it automatically captures session UUIDs and restores them using `claude --resume <sessionId>`. Also provides a signal notification system — status bar alerts when Claude finishes a task in a background terminal.

## Commands

```bash
npm run compile          # Build extension (esbuild → dist/extension.js)
npm run watch            # Build + watch for changes
npm run test             # Run all tests (vitest)
npm run test:watch       # Run tests in watch mode
npx vitest run test/terminalManager.test.ts  # Run single test file
npm run package          # Package as .vsix (vsce package)
```

To install locally: `code --install-extension cc-persist-*.vsix`

## Architecture

**Session persistence flow:**
1. Activation injects `DTACH_SIGNAL_DIR` into every terminal through `environmentVariableCollection`.
2. **PID lane:** the `SessionStart` hook always atomically publishes `pid-<claudePid>.sid` through a `.tmp` + `mv`, with JSON `{"sessionId":"<uuid>","cwd":"/absolute/path"}`. `pidResolver.ts` first verifies that the reported process is Claude, then walks its ancestry to a VS Code terminal's `processId`; `adoptWithSessionId()` tracks that terminal and saves its UUID + cwd without a name. A terminal profile that runs Claude directly or uses `exec claude` resolves because the Claude PID may itself be the shell PID. A strict Claude-ancestor guard runs before the shell match so nested `claude -p` descendants cannot replace the outer session, even when the outer Claude is the terminal shell. PID files older than 60 seconds are deleted before resolution to defend against PID reuse.
3. **Legacy index lane:** `SignalWatcher` still ingests `<index>.sid` files left by older hook configurations, including bare UUID payloads, during migration. The current hook never writes this filename. `cc-persist.newTerminal` continues to inject `DTACH_SOCKET_INDEX` only because completion, permission, and error signal hooks require it. **No `name` is passed to `vscode.window.createTerminal`** — Claude Code 2.1.139+ owns the tab title via OSC escape sequences.
4. Renaming with `cmd+shift+R` is optional and cosmetic. `renameTerminal()` stores a display name and sends `/rename`; saves happen on session-ID capture, rename, terminal close, and shutdown.
5. On VS Code reopen → `restoreTerminals()` reads v2 state (or migrates v1 name-only entries), creates terminals with no `name` option in the saved cwd when it still exists (otherwise the workspace start directory), and runs `claude <resumeFlags> --resume '<sessionId>'`. Legacy entries fall back to the saved name. When the default shell is zsh or bash, restore creates the terminal with `shellPath` and `shellArgs: ["-lc", "claude <resumeFlags> --resume '<handle>'; exec '<shell>' -il"]` (nothing is typed and VS Code does not inject shell integration into these terminals); other shells fall back to an immediate `sendText`.

**Required VS Code user setting** (for Claude's OSC titles to render in the tab):
```json
"terminal.integrated.tabs.title": "${sequence}"
```
Without this, VS Code's default `${process}` template wins and tabs show the running process string (e.g., "2.1.139") instead of Claude's session name.

**Signal notification flow:**
1. Shell hooks write signal files (e.g., `0.signal`, `1.permission`, `2.error`) to `$TMPDIR/dtach-persist/<workspaceId>/signals/`; `SessionStart` always writes `pid-<claudePid>.sid`, while `<index>.sid` ingestion is legacy-only
2. `SignalWatcher` detects via `fs.watch` + 10s poll fallback. Both `.sid` lanes update persistence and never enter the status-bar signal map
3. Status bar shows count with urgency (permission/error = alert icon, complete = bell)
4. Click cycles through signals or shows quick pick; switching to terminal auto-clears its signal
5. External `goto` file support — cc-overlord writes terminal index to jump to

**Key modules:**
- `extension.ts` — Activation wiring: creates TerminalManager, SignalWatcher, registers commands and timers
- `pidResolver.ts` — Process-table parsing and ancestry matching, including the nested-Claude guard
- `terminalManager.ts` — Terminal lifecycle: create, track, save/load state, restore sessions. Tracks UUIDs and validated absolute working directories by terminal index, and validates legacy session names and configurable resume flags
- `signalWatcher.ts` — File-based signal system: ingests `.sid` files and watches `.signal`/`.permission`/`.error` files, manages status bar, handles configurable stale signal pruning
- `config.ts` — Path resolution: workspace ID (folder name + hash), state dir (`~/.cc-persist/`), signal dir (`$TMPDIR/dtach-persist/`)
- `types.ts` — `SessionInfo` and `SessionState` interfaces

## Testing

Tests use vitest with a VS Code mock at `test/__mocks__/vscode.ts` (aliased in vitest.config.ts). The mock provides fake `window.createTerminal`, event emitters, etc. Tests create real temp directories for state files.

Stress tests (`*.stress.test.ts`) cover: duplicate indices, invalid state schemas, rapid create/close cycles, name validation edge cases, idempotent restore, index collision avoidance.

## Key Design Decisions

- **Session UUID is the persistence handle** — the `SessionStart` hook captures it automatically. Session names are display-only metadata and a legacy v1 resume fallback.
- **Claude Code owns the tab title** — cc-persist does not pass `name` to `vscode.window.createTerminal` in either the new-terminal or restore paths. Claude Code 2.1.139+ emits OSC title sequences. Requires user's `terminal.integrated.tabs.title` to include `${sequence}` (see Architecture).
- **Env var names kept as `DTACH_SIGNAL_DIR`/`DTACH_SOCKET_INDEX`** — legacy names preserved so existing shell hooks and cc-overlord don't need updates
- **`DTACH_SOCKET_INDEX` is signal-only** — it remains injected for `.signal`, `.permission`, and `.error` hooks; current session capture always uses the PID lane
- **`isTransient: true`** on created terminals — VS Code won't restore them natively (the extension handles restore)
- **Resume inputs validated** — UUID and legacy-name validation protect the handle; configurable resume flags use a strict whitelist before entering the shell command
- **`terminal.exitStatus.reason` decides on close** — User prunes the entry and saves; every other reason (Process, Shutdown, Extension, Unknown, undefined) preserves state on disk (a kept-by-mistake entry costs one extra restored tab, a pruned-by-mistake entry loses a session)
- **State writes are atomic** — temporary file plus rename
- **`restored` flag** — `restoreTerminals()` is idempotent, second call returns empty
