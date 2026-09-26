# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Instead of keeping processes alive (the old dtach approach), it automatically captures session UUIDs and restores them using `claude --resume <sessionId>`.

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

Upgrading from ≤0.4.x: run `scripts/migrate-name-only.py` (with VS Code quit) BEFORE installing 0.5.0; 0.5.0 loads only session-ID entries and the first save rewrites state.json without name-only entries.

## Architecture

**Session persistence flow:**
1. Activation injects `DTACH_SIGNAL_DIR` into every terminal through `environmentVariableCollection`.
2. **PID lane:** the `SessionStart` hook always atomically publishes `pid-<claudePid>.sid` through a `.tmp` + `mv`, with JSON `{"sessionId":"<uuid>","cwd":"/absolute/path"}`. `pidResolver.ts` first verifies that the reported process is Claude, then walks its ancestry to a VS Code terminal's `processId`; `adoptWithSessionId()` tracks that terminal and saves its UUID + cwd without a name. A terminal profile that runs Claude directly or uses `exec claude` resolves because the Claude PID may itself be the shell PID. A strict Claude-ancestor guard runs before the shell match so nested `claude -p` descendants cannot replace the outer session, even when the outer Claude is the terminal shell. A capture file is retried until its PID stops being a live Claude process, with a 30-minute give-up; there is no short staleness window.
3. **No `name` is passed to `vscode.window.createTerminal`** — Claude Code 2.1.139+ owns the tab title via OSC escape sequences. Saves happen on session-ID capture, terminal close, and shutdown.
4. On VS Code reopen → `restoreTerminals()` reads v2 state, creates terminals with no `name` option in the saved cwd when it still exists (otherwise the workspace start directory), and runs `claude <resumeFlags> --resume '<sessionId>'`. When the default shell is zsh or bash, restore creates the terminal with `shellPath` and `shellArgs: ["-lc", "claude <resumeFlags> --resume '<sessionId>'; exec '<shell>' -il"]` (nothing is typed and VS Code does not inject shell integration into these terminals); other shells fall back to an immediate `sendText`.

**Required VS Code user setting** (for Claude's OSC titles to render in the tab):
```json
"terminal.integrated.tabs.title": "${sequence}"
```
Without this, VS Code's default `${process}` template wins and tabs show the running process string (e.g., "2.1.139") instead of Claude's session name.

**Key modules:**
- `extension.ts` — Activation wiring: creates TerminalManager and SidWatcher, registers the newTerminal command, runs restore
- `pidResolver.ts` — Process-table parsing and ancestry matching, including the nested-Claude guard
- `terminalManager.ts` — Terminal lifecycle: create, track, save/load state, restore sessions. Tracks UUIDs and validated absolute working directories by terminal index, and validates display names and configurable resume flags
- `sidWatcher.ts` — Watches the signal dir (`fs.watch` + 10s poll) for `pid-<pid>.sid` captures and hands them to the PID resolver; nothing else
- `config.ts` — Path resolution: workspace ID (folder name + hash), state dir (`~/.cc-persist/`), signal dir (`$TMPDIR/dtach-persist/`)
- `types.ts` — `SessionInfo` and `SessionState` interfaces

## Testing

Tests use vitest with a VS Code mock at `test/__mocks__/vscode.ts` (aliased in vitest.config.ts). The mock provides fake `window.createTerminal`, event emitters, etc. Tests create real temp directories for state files.

Stress tests (`*.stress.test.ts`) cover: duplicate indices, invalid state schemas, rapid create/close cycles, name validation edge cases, idempotent restore, index collision avoidance.

## Key Design Decisions

- **Session UUID is the persistence handle** — the `SessionStart` hook captures it automatically. Session names are display-only metadata.
- **Claude Code owns the tab title** — cc-persist does not pass `name` to `vscode.window.createTerminal` in either the new-terminal or restore paths. Claude Code 2.1.139+ emits OSC title sequences. Requires user's `terminal.integrated.tabs.title` to include `${sequence}` (see Architecture).
- **Env var name kept as `DTACH_SIGNAL_DIR`** — legacy name preserved so the existing SessionStart hook keeps working. `DTACH_SOCKET_INDEX` and the notification hooks were removed in 0.6.0.
- **`isTransient: true`** on created terminals — VS Code won't restore them natively (the extension handles restore)
- **Resume inputs validated** — UUID validation protects the handle; configurable resume flags use a strict whitelist before entering the shell command
- **`terminal.exitStatus.reason` decides on close** — User prunes the entry and saves; every other reason (Process, Shutdown, Extension, Unknown, undefined) preserves state on disk (a kept-by-mistake entry costs one extra restored tab, a pruned-by-mistake entry loses a session)
- **State writes are atomic** — temporary file plus rename
- **`restored` flag** — `restoreTerminals()` is idempotent, second call returns empty
