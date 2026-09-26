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
1. Activation creates `RegistryWatcher` on `~/.claude/sessions` (or `<CLAUDE_CONFIG_DIR>/sessions` when the environment variable is nonempty). Capture waits until terminal restore completes, then runs one full reconcile. Directory events are debounced by 300 ms; there is no periodic registry poll. A missing directory is never created: the watcher logs the failure and retries attaching every 30 seconds.
2. `sessionRegistry.ts` reads `claude agents --json` via `execFile` with a five-second timeout, falling back to the directory's `<pid>.json` files on command failure, empty output, or invalid output. Both paths validate PID and session UUID, skip malformed rows and background jobs, and never write to the registry. For each unadopted interactive PID, `pidResolver.ts` verifies that it is Claude and walks ancestry to a VS Code terminal's `processId`; `adoptWithSessionId()` saves its UUID and validated cwd without a name. Direct Claude terminal profiles and `exec claude` work because the Claude PID can be the terminal PID. The Claude-ancestor guard prevents nested Claude processes from replacing the outer session. Adoption shares one process snapshot per reconcile, skips adopted or in-flight PIDs, and retries unresolved rows up to three times two seconds apart before waiting for another event.
3. **No `name` is passed to `vscode.window.createTerminal`** — Claude Code 2.1.139+ owns the tab title via OSC escape sequences. Saves happen on session adoption and user-initiated terminal close; shutdown preserves the saved entries.
4. On VS Code reopen → `restoreTerminals()` reads v2 state, creates terminals with no `name` option in the saved cwd when it still exists (otherwise the workspace start directory), and runs `claude <resumeFlags> --resume '<sessionId>'`. When the default shell is zsh or bash, restore creates the terminal with `shellPath` and `shellArgs: ["-lc", "claude <resumeFlags> --resume '<sessionId>'; exec '<shell>' -il"]` (nothing is typed and VS Code does not inject shell integration into these terminals); other shells fall back to an immediate `sendText`.

**Required VS Code user setting** (for Claude's OSC titles to render in the tab):
```json
"terminal.integrated.tabs.title": "${sequence}"
```
Without this, VS Code's default `${process}` template wins and tabs show the running process string (e.g., "2.1.139") instead of Claude's session name.

**Key modules:**
- `extension.ts` — Activation wiring: creates TerminalManager and RegistryWatcher, registers the newTerminal command, runs restore, caches adopted terminals by PID, and handles optional status toasts
- `pidResolver.ts` — Process-table parsing and ancestry matching, including the nested-Claude guard
- `terminalManager.ts` — Terminal lifecycle: create, track, save/load state, restore sessions. Tracks UUIDs and validated absolute working directories by terminal index, and validates display names and configurable resume flags
- `sessionRegistry.ts` — Resolves the sessions directory and reads validated interactive rows through the CLI or file fallback
- `registryWatcher.ts` — Watches the registry with `fs.watch`, defers capture until restore completes, debounces events, and bounds adoption retries
- `config.ts` — Path resolution: workspace ID (folder name + hash), state dir (`~/.cc-persist/`), and cc-overlord metadata base (`$TMPDIR/dtach-persist/`)
- `types.ts` — `SessionInfo` and `SessionState` interfaces

## Testing

Tests use vitest with a VS Code mock at `test/__mocks__/vscode.ts` (aliased in vitest.config.ts). The mock provides fake terminals and event emitters. Tests create real temp directories for state files. The registry reader accepts an injected `runAgents`; the watcher accepts injected registry and process readers for isolated verification.

Stress tests (`*.stress.test.ts`) cover: duplicate indices, invalid state schemas, rapid create/close cycles, name validation edge cases, idempotent restore, index collision avoidance.

## Key Design Decisions

- **Session UUID is the persistence handle** — capture reads it from Claude Code's live-session registry. Session names are display-only metadata.
- **Claude Code owns the tab title** — cc-persist does not pass `name` to `vscode.window.createTerminal` in either the new-terminal or restore paths. Claude Code 2.1.139+ emits OSC title sequences. Requires user's `terminal.integrated.tabs.title` to include `${sequence}` (see Architecture).
- **No env injection, no hook: capture reads Claude Code's registry** — the registry is read-only; `names.json` and `workspace.json` remain in the cc-overlord metadata base.
- **`isTransient: true`** on created terminals — VS Code won't restore them natively (the extension handles restore)
- **Resume inputs validated** — UUID validation protects the handle; configurable resume flags use a strict whitelist before entering the shell command
- **`terminal.exitStatus.reason` decides on close** — User prunes the entry and saves; every other reason (Process, Shutdown, Extension, Unknown, undefined) preserves state on disk (a kept-by-mistake entry costs one extra restored tab, a pruned-by-mistake entry loses a session)
- **State writes are atomic** — temporary file plus rename
- **`restored` flag** — `restoreTerminals()` is idempotent, second call returns empty
