#!/usr/bin/env python3
"""Back up and merge cc-persist state after a lossy VS Code quit."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
CODE_EXECUTABLE_SUFFIX = "Visual Studio Code.app/Contents/MacOS/Code"

def expanded(value):
    return Path(value).expanduser()

def workspace_names(root):
    if not root.is_dir():
        return set()
    return {item.name for item in root.iterdir() if (item / "state.json").is_file()}

def valid_workspace(value):
    return isinstance(value, str) and value not in ("", ".", "..") and Path(value).name == value

def warn(message):
    print(f"warning: {message}", file=sys.stderr)

def read_entries(state_path):
    if not state_path.is_file():
        return []
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        warn(f"skipping unreadable {state_path}: {exc}")
        return None
    if not isinstance(state, dict) or state.get("version") != 2 or not isinstance(state.get("terminals"), list):
        warn(f"skipping invalid v2 state in {state_path}")
        return None
    entries = [entry for entry in state["terminals"] if isinstance(entry, dict)]
    if len(entries) != len(state["terminals"]):
        warn(f"skipping non-object terminal entries in {state_path}")
    return entries

def atomic_write(state_path, entries):
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = state_path.with_name(f"{state_path.name}.{os.getpid()}.tmp")
    temp_path.write_text(json.dumps({"version": 2, "terminals": entries}), encoding="utf-8")
    temp_path.chmod(0o600)
    os.replace(temp_path, state_path)

def vscode_running():
    # pgrep -f cannot see the main VS Code process's command line on macOS; ps -o comm can.
    try:
        output = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True, check=False).stdout
        return any(line.strip().endswith(CODE_EXECUTABLE_SUFFIX) for line in output.splitlines())
    except Exception:
        return True

def backup(args):
    root = expanded(args.root)
    backup_root = expanded(args.backup_root)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    destination = backup_root / timestamp
    suffix = 0
    while destination.exists():
        suffix += 1
        destination = backup_root / f"{timestamp}-{suffix}"
    destination.mkdir(parents=True, exist_ok=False)
    count = 0
    for workspace in sorted(workspace_names(root)):
        target = destination / workspace / "state.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / workspace / "state.json", target)
        count += 1
    print(f"Backup directory: {destination}")
    print(f"State files copied: {count}")
    return 0

def load_adds(adds_file):
    grouped = {}
    if not adds_file:
        return grouped
    try:
        adds = json.loads(expanded(adds_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read adds file: {exc}") from exc
    if not isinstance(adds, list):
        raise ValueError("adds file must contain a JSON array")
    for number, entry in enumerate(adds, 1):
        if not isinstance(entry, dict) or not valid_workspace(entry.get("workspace")):
            warn(f"skipping adds entry {number} with invalid workspace")
            continue
        grouped.setdefault(entry["workspace"], []).append(entry)
    return grouped

def merge(args):
    if not args.force and vscode_running():
        print("refusing to merge while Visual Studio Code is running; quit it or use --force", file=sys.stderr)
        return 2
    root = expanded(args.root)
    backup_root = expanded(args.backup)
    try:
        adds = load_adds(args.adds_file)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    workspaces = workspace_names(root) | workspace_names(backup_root) | set(adds)
    rows = []
    for workspace in sorted(workspaces):
        current_path = root / workspace / "state.json"
        entries = read_entries(current_path)
        if current_path.is_file() and entries is None:
            rows.append((workspace, "skipped (unreadable or not v2)", "-", "-"))
            continue
        entries = entries or []
        before = len(entries)
        seen = {entry["sessionId"].lower() for entry in entries if isinstance(entry.get("sessionId"), str)}
        indexes = [entry.get("index") for entry in entries]
        next_index = max((index for index in indexes if isinstance(index, int) and index >= 0), default=-1) + 1
        added = []
        backup_entries = read_entries(backup_root / workspace / "state.json") or []
        candidates = backup_entries + adds.get(workspace, [])
        for entry in candidates:
            session_id = entry.get("sessionId")
            if not isinstance(session_id, str) or not UUID_RE.fullmatch(session_id):
                warn(f"skipping invalid sessionId in workspace {workspace}: {session_id!r}")
                continue
            session_id = session_id.lower()
            if session_id in seen:
                continue
            recovered = {"index": next_index, "sessionId": session_id}
            for field in ("name", "cwd"):
                if isinstance(entry.get(field), str):
                    recovered[field] = entry[field]
            entries.append(recovered)
            seen.add(session_id)
            added.append(session_id[:8])
            next_index += 1
        if not args.dry_run:
            atomic_write(current_path, entries)
        rows.append((workspace, before, len(entries), ",".join(added) or "-"))
    print("workspace | before | after | added ids")
    print("----------|--------|-------|----------")
    for workspace, before, after, added_ids in rows:
        print(f"{workspace} | {before} | {after} | {added_ids}")
    return 0

def make_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    backup_parser = subparsers.add_parser("backup", help="back up all workspace state files")
    backup_parser.add_argument("--root", default="~/.cc-persist")
    backup_parser.add_argument("--backup-root", default="~/.cc-persist-backups")
    backup_parser.set_defaults(func=backup)
    merge_parser = subparsers.add_parser("merge", help="merge recovered session IDs into current state")
    merge_parser.add_argument("--backup", required=True, help="timestamped backup directory")
    merge_parser.add_argument("--adds-file", help="JSON array of additional sessions")
    merge_parser.add_argument("--root", default="~/.cc-persist")
    merge_parser.add_argument("--dry-run", action="store_true")
    merge_parser.add_argument("--force", action="store_true")
    merge_parser.set_defaults(func=merge)
    return parser

if __name__ == "__main__":
    parsed = make_parser().parse_args()
    raise SystemExit(parsed.func(parsed))
