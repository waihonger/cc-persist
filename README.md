# CC Persist

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Saves terminal names and restores them using `claude --resume`. Includes a signal notification system for cross-terminal task completion alerts.

## How it works

```
You rename a terminal → extension saves state to disk
You close VS Code → state preserved (delayed cleanup + disposing flag)
You reopen VS Code → terminals restored with `claude --dangerously-skip-permissions --resume '<name>'`
```

Signal notifications:

```
Claude finishes in background terminal
  → Stop hook writes signal file
  → Status bar shows: 🔔 2 awaiting
  → Ctrl+Cmd+Option+M (or click) → jump to that terminal
```

## Requirements

- VS Code 1.85+
- [Claude Code](https://claude.ai/code) with hooks configured (see below)
- Optional: [cc-overlord](https://github.com/waihonger/cc-overlord) for cross-workspace notifications via menu bar

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

## Architecture

**Session persistence:**
1. User creates terminal via `cc-persist.newTerminal` → assigns index, injects `DTACH_SIGNAL_DIR` and `DTACH_SOCKET_INDEX` env vars
2. User renames terminal (`Cmd+Shift+R`) → state saved to `~/.cc-persist/<workspaceId>/state.json`
3. VS Code shuts down → `setDisposing()` cancels pending cleanups, saves state while maps are intact
4. VS Code reopens → `restoreTerminals()` reads state, creates terminals, runs `claude --resume`

**Shutdown race condition handling:**
Terminal close events fire before `deactivate()` during VS Code shutdown. The extension uses a delayed cleanup pattern (300ms) — same as [dtach-persist](https://github.com/waihonger/dtach-vscode-persist) — so `setDisposing()` can cancel pending cleanups and save the full state before maps are cleared.

**Signal notifications:**
Shell hooks write signal files (`.signal`, `.permission`, `.error`) to `$TMPDIR/dtach-persist/<workspaceId>/signals/`. The extension watches via `fs.watch` + 10s poll fallback, shows status bar alerts, and auto-clears signals for the active terminal.

**cc-overlord integration:**
Writes `names.json` and `workspace.json` to the signal base directory so [cc-overlord](https://github.com/waihonger/cc-overlord) can display terminal names and open the right VS Code workspace.

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
