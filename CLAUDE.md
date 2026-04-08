# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Instead of keeping processes alive (the old dtach approach), it saves terminal names and restores them using `claude --resume <name>`. Also provides a signal notification system — status bar alerts when Claude finishes a task in a background terminal.

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
1. User creates terminal via `cc-persist.newTerminal` command → `TerminalManager.createTerminal()` assigns monotonic index, injects `DTACH_SIGNAL_DIR` and `DTACH_SOCKET_INDEX` env vars
2. User runs Claude, does `/rename <name>` → VS Code tab title updates
3. `saveState()` writes `{version: 1, terminals: [{name, index}]}` to `~/.cc-persist/<workspaceId>/state.json` (periodic 30s timer + on terminal close/focus)
4. On VS Code reopen → `restoreTerminals()` reads state, creates terminals, runs `claude --resume '<name>'` via `sendText`

**Signal notification flow:**
1. Shell hook writes signal file (e.g., `0.signal`, `1.permission`, `2.error`) to `$TMPDIR/dtach-persist/<workspaceId>/signals/`
2. `SignalWatcher` detects via `fs.watch` + 10s poll fallback
3. Status bar shows count with urgency (permission/error = alert icon, complete = bell)
4. Click cycles through signals or shows quick pick; switching to terminal auto-clears its signal
5. External `goto` file support — cc-overlord writes terminal index to jump to

**Key modules:**
- `extension.ts` — Activation wiring: creates TerminalManager, SignalWatcher, registers commands and timers
- `terminalManager.ts` — Terminal lifecycle: create, track, save/load state, restore sessions. Validates session names against `SAFE_NAME_RE` to prevent shell injection via `sendText`
- `signalWatcher.ts` — File-based signal system: watches for `.signal`/`.permission`/`.error` files, manages status bar, handles stale signal pruning (4h threshold)
- `config.ts` — Path resolution: workspace ID (folder name + hash), state dir (`~/.cc-persist/`), signal dir (`$TMPDIR/dtach-persist/`)
- `types.ts` — `SessionInfo` and `SessionState` interfaces

## Testing

Tests use vitest with a VS Code mock at `test/__mocks__/vscode.ts` (aliased in vitest.config.ts). The mock provides fake `window.createTerminal`, event emitters, etc. Tests create real temp directories for state files.

Stress tests (`*.stress.test.ts`) cover: duplicate indices, invalid state schemas, rapid create/close cycles, name validation edge cases, idempotent restore, index collision avoidance.

## Key Design Decisions

- **Env var names kept as `DTACH_SIGNAL_DIR`/`DTACH_SOCKET_INDEX`** — legacy names preserved so existing shell hooks and cc-overlord don't need updates
- **`isTransient: true`** on created terminals — VS Code won't restore them natively (the extension handles restore)
- **Session names validated** before use in `sendText` — regex whitelist prevents shell injection
- **`disposing` flag** — when VS Code shuts down, terminal close events preserve state instead of removing entries (so sessions survive restart)
- **`restored` flag** — `restoreTerminals()` is idempotent, second call returns empty
