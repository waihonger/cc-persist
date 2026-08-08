# CC Persist

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Unlike [dtach-persist](https://github.com/waihonger/dtach-vscode-persist) which keeps processes alive via dtach sockets, cc-persist uses Claude Code's native `--resume` feature — no background processes, just automatically captured session IDs.

## Workflow

### First time setup

1. Install the extension
2. Configure Claude Code hooks (see below)
3. Optionally install [cc-overlord](https://github.com/waihonger/cc-overlord) for cross-workspace menu bar notifications

### Daily usage

1. **Open VS Code** — saved terminals auto-restore, each running `claude --dangerously-skip-permissions --resume '<session-id>'`
2. **Create terminals** — use `cc-persist.newTerminal` (from command palette). This creates a managed terminal with signal env vars injected
3. **Start Claude** — run `claude` (or `claude --dangerously-skip-permissions`) in the terminal
4. **Optionally rename** — `Cmd+Shift+R` while terminal is focused. This is cosmetic: it stores a display name and sends `/rename <name>` to Claude, whose OSC title sequence updates the tab. Persistence is already automatic through the session ID. Duplicate display names are auto-suffixed (`name`, `name-2`, `name-3`, …)
5. **Work across terminals** — switch between terminals, leave Claude working in background ones
6. **Get notified** — when Claude finishes in a background terminal, the status bar shows `🔔 N awaiting`. Press `Ctrl+Cmd+Option+M` to jump to the highest priority one (permission requests first, then errors, then completions)
7. **Close VS Code** — state is preserved. Reopen and everything restores

### How it differs from dtach-persist

| | cc-persist | dtach-persist |
|---|---|---|
| Session survival | Saves UUIDs, resumes via `claude --resume` | Keeps processes alive via dtach sockets |
| Background processes | None | dtach daemon per terminal |
| Restore mechanism | Creates fresh terminal + shell command | Reattaches to existing dtach socket |
| Session state | Claude conversation resumed in a fresh process | Fully preserved (same process) |
| Complexity | Simple — just save/restore UUIDs | Requires dtach binary + socket management |

## Requirements

- VS Code 1.93+
- [Claude Code](https://claude.ai/code) 2.1.139+ — owns the tab title via OSC escape sequences
- VS Code user setting: `"terminal.integrated.tabs.title": "${sequence}"` — without this, VS Code's default `${process}` template wins and tabs show the running process string (e.g., "2.1.139") instead of Claude's session name
- [Claude Code](https://claude.ai/code) hooks configured (see below)
- `jq` (`brew install jq`) — the `SessionStart` hook uses it to extract the session UUID; without it, session-ID persistence silently degrades to name-only
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
| `cc-persist.renameTerminal` | `Cmd+Shift+R` (terminal focus) | Set an optional display name |
| `cc-persist.cycleSignal` | `Ctrl+Cmd+Option+M` | Jump to next waiting terminal |

## Configure Claude Code hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "test -n \"$DTACH_SIGNAL_DIR\" && test -n \"$DTACH_SOCKET_INDEX\" && jq -r .session_id > \"$DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.sid.tmp\" && mv \"$DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.sid.tmp\" \"$DTACH_SIGNAL_DIR/$DTACH_SOCKET_INDEX.sid\" || true", "timeout": 1000 }] }
    ],
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

The `SessionStart` hook captures the session UUID on every start, resume, and clear. It writes to a `.tmp` file and renames it so the watcher never reads a partial write; the extension consumes the `.sid` file without displaying it in the status bar.

Three notification signal types:
- **Stop** → `.signal` file → "done" (yellow in status bar)
- **PermissionRequest** → `.permission` file → "needs approval" (red, urgent)
- **StopFailure** → `.error` file → "error" (red, urgent)

## Architecture

**State persistence:**
- State saved to `~/.cc-persist/<workspaceId>/state.json` — survives reboots
- Signal files in `$TMPDIR/dtach-persist/<workspaceId>/signals/` — ephemeral
- `SessionStart` writes `<index>.sid`; the watcher maps the terminal index to its UUID and immediately saves v2 state
- Session names are optional display metadata and a fallback for legacy v1 state
- `names.json` and `workspace.json` written to signal base dir for cc-overlord

**Shutdown handling:**
Terminal close events fire before `deactivate()` during VS Code shutdown. The extension uses a delayed cleanup pattern (300ms) so `setDisposing()` can cancel pending cleanups and save the full state before maps are cleared.

**Restore flow:**
1. Load state from disk
2. Close rogue terminals that VS Code auto-creates (unless `cc-persist.closeRogueTerminals` is disabled)
3. Set up watcher for new rogue terminals
4. After 150ms (or when rogue appears) — create terminals with env vars, resume by UUID (or by name for legacy entries)

**Signal flow:**
1. Claude Code hooks write signal files using `DTACH_SIGNAL_DIR` + `DTACH_SOCKET_INDEX` env vars
2. `fs.watch` + 10s poll fallback detects new signals
3. Status bar shows count with urgency indicators
4. Signals auto-clear when you switch to that terminal
5. Signals auto-clear after 4 hours (configurable via `cc-persist.staleSignalHours`)

## Settings

| Setting | Default | Description |
|---|---|---|
| `cc-persist.resumeFlags` | `--dangerously-skip-permissions` | Flags passed to `claude` during restore. Values containing shell metacharacters are rejected |
| `cc-persist.staleSignalHours` | `4` | Hours before unattended notification signals are removed |
| `cc-persist.closeRogueTerminals` | `true` | Close untracked terminals that VS Code creates while saved sessions restore |

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
