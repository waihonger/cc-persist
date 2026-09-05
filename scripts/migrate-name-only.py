#!/usr/bin/env python3
"""Convert cc-persist name-only state entries to session-ID entries."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
TITLE_PATTERN = r'"type":"custom-title","customTitle":"[^"]*","sessionId":"[0-9a-f-]*"'
CWD_RE = re.compile(r'"cwd"\s*:\s*("(?:\\.|[^"\\])*")')
CODE_EXECUTABLE_SUFFIX = "Visual Studio Code.app/Contents/MacOS/Code"

def arguments() -> argparse.Namespace:
    home = Path.home()
    parser = argparse.ArgumentParser(description="Migrate name-only state using Claude transcripts.")
    parser.add_argument("--root", type=Path, default=home / ".cc-persist")
    parser.add_argument("--projects", type=Path, default=home / ".claude" / "projects")
    parser.add_argument("--cache", type=Path, default=home / ".cc-persist-backups" / "custom-titles.txt")
    parser.add_argument("--dry-run", action="store_true", help="report without writing state")
    parser.add_argument("--force", action="store_true", help="include workspaces open in VS Code")
    parser.add_argument("--rebuild-cache", action="store_true", help="rescan all transcripts")
    return parser.parse_args()

def atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(text)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

def title_lines(projects: Path, cache: Path, rebuild: bool) -> str:
    if cache.is_file() and not rebuild:
        return cache.read_text(encoding="utf-8")
    result = subprocess.run(
        ["grep", "-rho", TITLE_PATTERN, str(projects), "--include=*.jsonl"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip() or f"grep exited {result.returncode}")
    atomic_text(cache, result.stdout)
    return result.stdout

def title_index(raw: str, stems: set[str]) -> dict[str, set[str]]:
    index: dict[str, set[str]] = {}
    for line in raw.splitlines():
        try:
            item = json.loads("{" + line + "}")
        except (json.JSONDecodeError, TypeError):
            continue
        name, session_id = item.get("customTitle"), item.get("sessionId")
        if not isinstance(name, str) or not isinstance(session_id, str):
            continue
        if UUID_RE.fullmatch(session_id) and session_id in stems:
            index.setdefault(name, set()).add(session_id)
    return index

def workspace_id(folder: str) -> str:
    absolute = os.path.abspath(folder)
    base = os.path.basename(absolute) or "vscode"
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", base).lstrip("-")[:32] or "vscode"
    digest = hashlib.sha256(absolute.encode()).hexdigest()[:6]
    return f"{sanitized[:25]}-{digest}"

def folder_path(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if parsed.scheme != "file":
        return None
    result = unquote(parsed.path)
    return f"//{parsed.netloc}{result}" if parsed.netloc not in ("", "localhost") else result

def vscode_running() -> bool:
    # pgrep -f cannot see the main VS Code process's command line on macOS; ps -o comm can.
    try:
        output = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True, check=False).stdout
        return any(line.strip().endswith(CODE_EXECUTABLE_SUFFIX) for line in output.splitlines())
    except Exception:
        return True

def open_workspace_ids() -> set[str]:
    storage = Path.home() / "Library/Application Support/Code/User/globalStorage/storage.json"
    if not storage.exists():
        return set()
    data = json.loads(storage.read_text(encoding="utf-8"))
    windows = data.get("windowsState", {})
    folders: list[object] = []
    for window in windows.get("openedWindows", []):
        if isinstance(window, dict):
            folders.append(window.get("folder"))
    last = windows.get("lastActiveWindow")
    if isinstance(last, dict):
        folders.append(last.get("folder"))
    return {workspace_id(folder) for value in folders if (folder := folder_path(value))}

def transcript_cwd(path: Path) -> str | None:
    try:
        with path.open("rb") as source:
            raw = source.read(64 * 1024).decode("utf-8", errors="replace")
        match = CWD_RE.search(raw)
        cwd = json.loads(match.group(1)) if match else None
        return cwd if isinstance(cwd, str) else None
    except (OSError, json.JSONDecodeError):
        return None

def narrow_by_cwd(matches: set[str], workspace: str, projects: Path) -> set[str]:
    narrowed: set[str] = set()
    for session_id in matches:
        for transcript in projects.glob(f"*/{session_id}.jsonl"):
            cwd = transcript_cwd(transcript)
            if cwd is not None and workspace_id(cwd) == workspace:
                narrowed.add(session_id)
                break
    return narrowed

def migrate(path: Path, titles: dict[str, set[str]], projects: Path,
            dry_run: bool) -> tuple[int, int, int, int, int, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0, 0, 0, 0, 0, "skipped (unreadable)"
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] not in (1, 2):
        return 0, 0, 0, 0, 0, "skipped (unknown version)"
    entries = data.get("terminals")
    if not isinstance(entries, list):
        return 0, 0, 0, 0, 0, "skipped (unreadable)"

    output: list[object] = []
    name_only = converted = disambiguated = ambiguous = no_match = 0
    for entry in entries:
        if isinstance(entry, dict) and UUID_RE.fullmatch(str(entry.get("sessionId", ""))):
            output.append(entry)
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        name_only += 1
        matches = titles.get(entry["name"], set())
        was_ambiguous = len(matches) > 1
        if was_ambiguous:
            matches = narrow_by_cwd(matches, path.parent.name, projects)
            if len(matches) == 1:
                disambiguated += 1
        if len(matches) == 1:
            output.append({"index": entry.get("index"), "sessionId": next(iter(matches)), "name": entry["name"]})
            converted += 1
        elif was_ambiguous:
            ambiguous += 1
        else:
            no_match += 1

    replacement = {"version": 2, "terminals": output}
    changed = data != replacement
    note = "dry-run" if dry_run and changed else "updated" if changed else "unchanged"
    if changed and not dry_run:
        try:
            atomic_text(path, json.dumps(replacement, separators=(",", ":")))
        except OSError:
            note = "skipped (unwritable)"
    return name_only, converted, disambiguated, ambiguous, no_match, note

def main() -> int:
    args = arguments()
    stems = {path.stem for path in args.projects.glob("*/*.jsonl")}
    try:
        titles = title_index(title_lines(args.projects, args.cache, args.rebuild_cache), stems)
    except (OSError, RuntimeError) as error:
        print(f"error: unable to build title index: {error}", file=sys.stderr)
        return 1
    open_ids: set[str] = set()
    if not args.force and vscode_running():
        try:
            open_ids = open_workspace_ids()
        except (OSError, json.JSONDecodeError, AttributeError, TypeError) as error:
            print(f"error: VS Code is running but storage.json cannot be parsed: {error}", file=sys.stderr)
            return 2

    print("workspace | name-only | converted | disambiguated | dropped-ambiguous | dropped-nomatch | note")
    totals = [0, 0, 0, 0, 0]
    for state_path in sorted(args.root.glob("*/state.json")):
        workspace = state_path.parent.name
        counts = ((0, 0, 0, 0, 0, "skipped (window open)") if workspace in open_ids
                  else migrate(state_path, titles, args.projects, args.dry_run))
        for index in range(5):
            totals[index] += counts[index]
        print(f"{workspace} | {counts[0]} | {counts[1]} | {counts[2]} | {counts[3]} | {counts[4]} | {counts[5]}")
    print(f"TOTALS | {totals[0]} | {totals[1]} | {totals[2]} | {totals[3]} | {totals[4]} |")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
