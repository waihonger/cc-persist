# CC Persist

VS Code extension that persists Claude Code terminal sessions across VS Code restarts. Unlike [dtach-persist](https://github.com/waihonger/dtach-vscode-persist) which keeps processes alive via dtach sockets, cc-persist uses Claude Code's native `--resume` feature — no background processes, just automatically captured session IDs. Version 0.7.0 captures sessions from Claude Code's live-session registry.

## Workflow

### First time setup

1. Install the extension
2. Set `terminal.integrated.tabs.title` to `${sequence}` so Claude owns the tab titles (see Requirements)

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
- [Claude Code](https://claude.ai/code) with a live-session registry, as observed in CLI 2.1.283. Claude owns the tab title via OSC escape sequences
- VS Code user setting: `"terminal.integrated.tabs.title": "${sequence}"` — without this, VS Code's default `${process}` template wins and tabs show the running process string (e.g., "2.1.139") instead of Claude's session name

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

## How capture works

Claude Code records live sessions in `~/.claude/sessions/<pid>.json`. When `CLAUDE_CONFIG_DIR` is set to a nonempty value in the extension's environment, cc-persist watches `<CLAUDE_CONFIG_DIR>/sessions` instead. It reads the registry through `claude agents --json` with a five-second timeout, falling back to parsing the directory's JSON files if the command fails or returns empty or malformed output. It accepts valid interactive sessions and skips background jobs and malformed rows. The registry is read-only for cc-persist; no hook configuration is needed.

After terminal restore completes, cc-persist scans once, then responds to directory changes with a 300 ms debounce. It matches each Claude PID to its owning VS Code terminal and saves the session UUID and working directory. Unresolved terminals get up to three retries two seconds apart, then wait for another directory event. There is no periodic registry poll. If the directory is missing, cc-persist retries attaching the watcher every 30 seconds without creating it.

## Architecture

**State persistence:**
- State saved to `~/.cc-persist/<workspaceId>/state.json` — survives reboots
- Interactive registry rows are matched by process ancestry to a VS Code terminal; successful adoption saves the session UUID and working directory
- The PID resolver accepts a terminal whose shell PID is the Claude PID itself, covering terminal profiles that run Claude directly or use `exec claude`
- The PID resolver checks for another Claude process before accepting any ancestor as a terminal shell, so nested `claude -p` calls cannot overwrite the terminal's real session, including when the outer Claude process is itself the shell PID
- PID-adopted terminals persist without a stored name
- Restore starts each session in its captured working directory when that directory still exists, otherwise it falls back to the workspace start directory
- Session names are optional, display-only metadata (kept in state for terminals renamed before 0.6.0)
- `names.json` and `workspace.json` written to `$TMPDIR/dtach-persist/<workspaceId>/` for cc-overlord

**Shutdown handling:**
Session IDs and working directories are saved on adoption. A terminal closed by the user is removed from saved state; other close reasons, including VS Code shutdown, preserve its saved entry for the next restore.

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
