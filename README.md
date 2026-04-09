# CC Persist

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Unlike [dtach-persist](https://github.com/waihonger/dtach-vscode-persist) which keeps processes alive via dtach sockets, cc-persist uses Claude Code's native `--resume` feature — no background processes, just saved session names.

## Workflow

### First time setup

1. Install the extension
2. Configure Claude Code hooks (see below)
3. Optionally install [cc-overlord](https://github.com/waihonger/cc-overlord) for cross-workspace menu bar notifications

### Daily usage

1. **Open VS Code** — saved terminals auto-restore, each running `claude --dangerously-skip-permissions --resume '<name>'`
2. **Create terminals** — use `cc-persist.newTerminal` (from command palette). This creates a managed terminal with signal env vars injected
3. **Start Claude** — run `claude` (or `claude --dangerously-skip-permissions`) in the terminal
4. **Rename** — `Cmd+Shift+R` while terminal is focused. This does three things: stores the name in the extension, sends `/rename <name>` to Claude, and renames the VS Code tab. State is saved to disk immediately
5. **Work across terminals** — switch between terminals, leave Claude working in background ones
6. **Get notified** — when Claude finishes in a background terminal, the status bar shows `🔔 N awaiting`. Press `Ctrl+Cmd+Option+M` to jump to the highest priority one (permission requests first, then errors, then completions)
7. **Close VS Code** — state is preserved. Reopen and everything restores

### How it differs from dtach-persist

| | cc-persist | dtach-persist |
|---|---|---|
| Session survival | Saves names, resumes via `claude --resume` | Keeps processes alive via dtach sockets |
| Background processes | None | dtach daemon per terminal |
| Restore mechanism | Creates fresh terminal + `sendText` | Reattaches to existing dtach socket |
| Session state | Lost on resume (new conversation context) | Fully preserved (same process) |
| Complexity | Simple — just save/restore names | Requires dtach binary + socket management |

## Requirements

- VS Code 1.85+
- [Claude Code](https://claude.ai/code) with hooks configured (see below)
- Optional: [cc-overlord](https://github.com/waihonger/cc-overlord) for cross-workspace notifications + global hotkey

## Install

```bash
git clone https://github.com/waihonger/cc-persist.git
cd cc-persist
npm install
npm run package
code --install-extension cc-persist-*.vsix
```

## Commands

| Command | Keybinding | Description |
|---|---|---|
| `cc-persist.newTerminal` | — | Create a new managed terminal |
| `cc-persist.renameTerminal` | `Cmd+Shift+R` (terminal focus) | Rename terminal + save state |
| `cc-persist.cycleSignal` | `Ctrl+Cmd+Option+M` | Jump to next waiting terminal |

## Configure Claude Code hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "test -n \"$DTACH_SIGNAL_DIR\" && test -n \"$DTACH_SOCKET_INDEX\" && touch \"$DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.signal\" || true", "timeout": 1000 }] }
    ],
    "PermissionRequest": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "test -n \"$DTACH_SIGNAL_DIR\" && test -n \"$DTACH_SOCKET_INDEX\" && touch \"$DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.permission\" || true", "timeout": 1000 }] }
    ],
    "StopFailure": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "test -n \"$DTACH_SIGNAL_DIR\" && test -n \"$DTACH_SOCKET_INDEX\" && touch \"$DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.error\" || true", "timeout": 1000 }] }
    ]
  }
}
```

Three signal types:
- **Stop** → `.signal` file → "done" (yellow in status bar)
- **PermissionRequest** → `.permission` file → "needs approval" (red, urgent)
- **StopFailure** → `.error` file → "error" (red, urgent)

## Architecture

**State persistence:**
- State saved to `~/.cc-persist/<workspaceId>/state.json` — survives reboots
- Signal files in `$TMPDIR/dtach-persist/<workspaceId>/signals/` — ephemeral
- `names.json` and `workspace.json` written to signal base dir for cc-overlord

**Shutdown handling:**
Terminal close events fire before `deactivate()` during VS Code shutdown. The extension uses a delayed cleanup pattern (300ms) so `setDisposing()` can cancel pending cleanups and save the full state before maps are cleared.

**Restore flow:**
1. Load state from disk
2. Close rogue terminals (VS Code auto-creates a default one)
3. Set up watcher for new rogue terminals
4. After 150ms (or when rogue appears) — create terminals with env vars, run `claude --resume`

**Signal flow:**
1. Claude Code hooks write signal files using `DTACH_SIGNAL_DIR` + `DTACH_SOCKET_INDEX` env vars
2. `fs.watch` + 10s poll fallback detects new signals
3. Status bar shows count with urgency indicators
4. Signals auto-clear when you switch to that terminal
5. Signals auto-clear after 4 hours (configurable via `DTACH_SIGNAL_STALE_HOURS`)

## Development

```bash
npm run compile      # Build
npm run watch        # Build + watch
npm run test         # Run tests (vitest)
npm run test:watch   # Watch mode
npm run package      # Package as .vsix
```

## License

MIT
