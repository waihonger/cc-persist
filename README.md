# CC Persist

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Unlike [dtach-persist](https://github.com/waihonger/dtach-vscode-persist) which keeps processes alive via dtach sockets, cc-persist uses Claude Code's native `--resume` feature — no background processes, just automatically captured session IDs. Since 0.6.0 that is all it does: the rename command and the completion/permission/error notifications were removed.

## Workflow

### First time setup

1. Install the extension
2. Configure Claude Code hooks (see below)

### Daily usage

1. **Open VS Code** — saved terminals auto-restore, each running `claude --dangerously-skip-permissions --resume '<session-id>'`
2. **Create terminals** — use `cc-persist.newTerminal` (from command palette) or VS Code's `+` button; both get automatic session persistence
3. **Start Claude** — run `claude` (or `claude --dangerously-skip-permissions`) in the terminal
4. **Work across terminals** — switch between terminals, leave Claude working in background ones
5. **Rename (optional)** — type `/rename <name>` in Claude; Claude Code owns the tab title
6. **Close VS Code** — state is preserved. Reopen and everything restores

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
- `jq` (`brew install jq`) — the `SessionStart` hook uses it to build the session UUID + working-directory payload; without it, session-ID persistence is unavailable

## Install

Upgrading from ≤0.4.x: run `scripts/migrate-name-only.py` (with VS Code quit) BEFORE installing 0.5.0; 0.5.0 loads only session-ID entries and the first save rewrites state.json without name-only entries.

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

## Configure Claude Code hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "if test -n \"$DTACH_SIGNAL_DIR\"; then sid_file=\"pid-$PPID.sid\"; jq -c '{sessionId:.session_id,cwd:.cwd}' > \"$DTACH_SIGNAL_DIR/$sid_file.tmp\" && mv \"$DTACH_SIGNAL_DIR/$sid_file.tmp\" \"$DTACH_SIGNAL_DIR/$sid_file\"; fi; true", "timeout": 1000 }] }
    ]
  }
}
```

The `SessionStart` hook captures the session UUID and absolute working directory on every start, resume, and clear. It always writes `pid-<claudePid>.sid`, using the hook's parent PID, with a JSON payload shaped like `{"sessionId":"<uuid>","cwd":"/absolute/path"}`. The `.tmp` + `mv` sequence makes publication atomic, and the extension consumes the `.sid` file without displaying it in the status bar.

## Architecture

**State persistence:**
- State saved to `~/.cc-persist/<workspaceId>/state.json` — survives reboots
- `pid-<pid>.sid` capture files in `$TMPDIR/dtach-persist/<workspaceId>/signals/` — ephemeral
- The extension injects `DTACH_SIGNAL_DIR` into all terminals through VS Code's environment variable collection
- **PID lane:** every new `SessionStart` capture writes `pid-<claudePid>.sid`; the extension verifies that PID is Claude, walks its process ancestry to a VS Code terminal's shell PID, adopts that terminal, and saves its UUID and working directory
- A capture file is retried until its PID stops being a live Claude process, with a 30-minute give-up; there is no short staleness window.
- The PID resolver accepts a terminal whose shell PID is the Claude PID itself, covering terminal profiles that run Claude directly or use `exec claude`
- The PID resolver checks for another Claude process before accepting any ancestor as a terminal shell, so nested `claude -p` calls cannot overwrite the terminal's real session, including when the outer Claude process is itself the shell PID
- PID-adopted terminals persist without a stored name
- Restore starts each session in its captured working directory when that directory still exists, otherwise it falls back to the workspace start directory
- Session names are optional, display-only metadata (kept in state for terminals renamed before 0.6.0)
- `names.json` and `workspace.json` written to signal base dir for cc-overlord

**Shutdown handling:**
Terminal close events fire before `deactivate()` during VS Code shutdown. The extension uses a delayed cleanup pattern (300ms) so `setDisposing()` can cancel pending cleanups and save the full state before maps are cleared.

**Restore flow:**
1. Load state from disk
2. Close rogue terminals that VS Code auto-creates (unless `cc-persist.closeRogueTerminals` is disabled)
3. Set up watcher for new rogue terminals
4. After 150ms (or when rogue appears) — create terminals in their saved working directories, falling back to the workspace start directory, then resume by UUID

## Settings

| Setting | Default | Description |
|---|---|---|
| `cc-persist.resumeFlags` | `--dangerously-skip-permissions` | Flags passed to `claude` during restore. Values containing shell metacharacters are rejected |
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
