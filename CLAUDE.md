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
1. User creates terminal via `cc-persist.newTerminal` command → `TerminalManager.createTerminal()` assigns monotonic index, injects `DTACH_SIGNAL_DIR` and `DTACH_SOCKET_INDEX` env vars. **No `name` is passed to `vscode.window.createTerminal`** — Claude Code 2.1.139+ owns the tab title via OSC escape sequences.
2. Claude's `SessionStart` hook writes `<index>.sid` containing the session UUID. `SignalWatcher` ingests it and calls `setSessionId()`, which immediately saves v2 state as `{version: 2, terminals: [{index, sessionId, name?}]}`.
3. Renaming with `cmd+shift+R` is optional and cosmetic. `renameTerminal()` stores a display name and sends `/rename`; saves happen on session-ID capture, rename, terminal close, and shutdown.
4. On VS Code reopen → `restoreTerminals()` reads v2 state (or migrates v1 name-only entries), creates terminals with no `name` option, and runs `claude <resumeFlags> --resume '<sessionId>'`. Legacy entries fall back to the saved name. Commands prefer terminal shell integration and fall back to `sendText` after 3 seconds.

**Required VS Code user setting** (for Claude's OSC titles to render in the tab):
```json
"terminal.integrated.tabs.title": "${sequence}"
```
Without this, VS Code's default `${process}` template wins and tabs show the running process string (e.g., "2.1.139") instead of Claude's session name.

**Signal notification flow:**
1. Shell hooks write signal files (e.g., `0.signal`, `1.permission`, `2.error`) to `$TMPDIR/dtach-persist/<workspaceId>/signals/`; `SessionStart` writes `0.sid`
2. `SignalWatcher` detects via `fs.watch` + 10s poll fallback. `.sid` files update persistence and never enter the status-bar signal map
3. Status bar shows count with urgency (permission/error = alert icon, complete = bell)
4. Click cycles through signals or shows quick pick; switching to terminal auto-clears its signal
5. External `goto` file support — cc-overlord writes terminal index to jump to

**Key modules:**
- `extension.ts` — Activation wiring: creates TerminalManager, SignalWatcher, registers commands and timers
- `terminalManager.ts` — Terminal lifecycle: create, track, save/load state, restore sessions. Tracks UUIDs by terminal index and validates legacy session names and configurable resume flags
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
- **`isTransient: true`** on created terminals — VS Code won't restore them natively (the extension handles restore)
- **Resume inputs validated** — UUID and legacy-name validation protect the handle; configurable resume flags use a strict whitelist before entering the shell command
- **`disposing` flag** — when VS Code shuts down, terminal close events preserve state instead of removing entries (so sessions survive restart)
- **`restored` flag** — `restoreTerminals()` is idempotent, second call returns empty
