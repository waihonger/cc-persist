# RECEIPT registry-shrink: cc-persist 0.7.0, capture from Claude Code's session registry

DISPATCH_BASE: f2a8b2eaac55fa0610e544c8b34a16d135c4e790
Branch: worktree-registry-shrink. Claim 64bafb3c. report_to = lane ccpersist-research (no gatekeeper seat; board b:23221).
Tip at receipt time: the commit that adds this file (see HANDED line). Last source commit: 97e626157af6059b2b8e1e4cd525bd976f772da1.

## Units

| Unit | Commit | Written by |
|---|---|---|
| U1 sessionRegistry.ts | b9c61cc | codex (gpt-6-astra, high) |
| U2 registryWatcher.ts, extension/config/terminalManager wiring | 6055dcc | codex; `src/sidWatcher.ts` trashed by me (codex `trash` exited 1), no source hand-typed |
| U3 notifications setting + onStatusChange | fe6006d | codex |
| U4 docs + 0.7.0 | 5668d13 | codex |
| U5 tests | ba66aa5 | codex |
| U1 fix: empty CLI array falls back to files | 97e6261 | codex (see Deviations) |

Nothing was hand-written by me in src or test. codex-U1.md, U1b, U2 to U5, OBS in this directory are the worker reports (U2 was dispatched twice; the first run STOPPED on the terminalManager conflict below and its report was overwritten by the second).

## Deviations

1. U1 verifier `node -e require('./dist/extension.js')` cannot run (`vscode` is external). Substituted `npm run compile` + `npx tsc --noEmit -p .`; lane accepted (b:23229).
2. terminalManager.ts scope: brief Whitelist allowed only `parseSidPayload` deletion but U2's verifier and Goal require zero DTACH_SIGNAL_DIR. Stopped, asked; lane ruling GO (b:23229) widened it to: signalDir import, sigDir getter, two `mkdirSync(this.sigDir)`, two DTACH_SIGNAL_DIR env entries. Restore logic, shellArgs, names.json, workspace.json untouched.
3. U3 kept although board b:23224 said cut; lane overrode (b:23226).
4. Observation run found a real gap: `claude agents --json` returning a valid empty `[]` (seen inside codex's sandbox: 0 rows vs 131 on the host) made `readRegistry` return nothing instead of falling back. Fixed in 97e6261 with tests (empty, background-only, invalid-only arrays fall back; a valid CLI result never reads files). Not lane-ruled; within U1's stated "empty output falls back".
5. README shutdown paragraph rewritten by codex: the old text described a `setDisposing` 300 ms cleanup that no longer exists in terminalManager.ts (checked by grep).
6. package-lock.json records version 0.2.0 (stale before this work); left untouched.
7. Design note, not changed: every registry event triggers a full reconcile with one `ps` snapshot and up to 3 retry rounds for unresolved rows. With ~130 rows on this machine, most owned by other terminals, this is per brief but busier than a per-row backoff would be.
8. Files moved into this directory via a codex `mv` (typist shell blocks mv).

## Verify

Per unit (green twice):
- U1: compile exit 0, tsc exit 0 (before the fix and after).
- U2: `npm run compile` exit 0, `npx tsc --noEmit -p .` exit 0, `rg -n "DTACH_SIGNAL_DIR|sidWatcher|parseSidPayload|signals" src/` prints nothing.
- U3: compile, tsc exit 0; package.json `cc-persist.notifications` boolean default false; notification tests in U5.
- U4: `grep -n "jq\|DTACH\|SessionStart\|signals/" README.md CLAUDE.md` prints nothing; `grep -c "0.7.0" package.json` = 1.
- U5: `npx vitest run test/sessionRegistry.test.ts test/registryWatcher.test.ts` twice: `Tests 47 passed (47)` both times (before the U1 fix).

Toolchain on the last source commit (97e6261):
- `npm run compile`: exit 0 (`dist/extension.js 29.0kb`).
- `npx tsc --noEmit -p .`: exit 0, no output.
- `npm test`: `Test Files 10 passed (10)`, `Tests 248 passed (248)`. Baseline at DISPATCH_BASE was 210 passed in 8 files; 199 after deleting parseSidPayload/SidWatcher tests, then +47 new, +2 for the U1 fix.
- Note: codex's sandbox reported 4 registryWatcher failures (EMFILE on fs.watch inside its sandbox); all pass on the host, three full runs.

## Phase 0

Scope (`git diff --name-only --diff-filter=d f2a8b2e` plus untracked, minus tests and briefs/receipts): CLAUDE.md, README.md, package.json, src/config.ts, src/extension.ts, src/registryWatcher.ts, src/sessionRegistry.ts, src/terminalManager.ts (non-empty). The shell hook forbids `$` and xargs, so the same patterns ran as `rg -H "@ts-nocheck|@ts-ignore|@ts-expect-error|stryMutAct|stryCov|__stryker__|__mutmut"` over those files: no matches. No .py files in scope.

## Mutation

No stryker in this repo; the negative-control tests stand in.

| Changed source file | Negative control |
|---|---|
| src/sessionRegistry.ts | test/sessionRegistry.test.ts: bad pid, short id, background row, unparsable file rejected; empty/invalid CLI array falls back |
| src/registryWatcher.ts | test/registryWatcher.test.ts: "negative control: an empty registry adopts nothing and leaves state.json untouched" (inode + mtime unchanged) |
| src/extension.ts | test/registryWatcher.test.ts notification block: default off and `{notifications:false}` make zero toast calls; active terminal and unknown pid suppressed |
| src/config.ts | none new (signalDir deletion only; test/config.test.ts unchanged and green, no signalDir test existed) |
| package.json | test/registryWatcher.test.ts notification block reads `cc-persist.notifications` through the mock (default false); the manifest entry itself was checked by grep, no mutation test |
| README.md | none: documentation, verified by the U4 grep (no jq/DTACH/SessionStart/signals/) |
| CLAUDE.md | none: documentation, verified by the U4 grep (no jq/DTACH/SessionStart/signals/) |
| src/terminalManager.ts | test/terminalManager.test.ts ("creates terminal without capture environment variables": `opts.env` undefined) + stress2 ("createTerminal/restoreTerminals do not create a signal directory") |

## Observation run

`node docs/receipts/2026-09/registry-shrink/observe.cjs` (bundled `sessionRegistry.cjs`, read-only), final run on the host after the fix:

```
{
  "sessionsDir": "/Users/fongy/.claude/sessions",
  "cliInteractiveRows": 130,
  "cliElapsedMs": 358.564,
  "fileFallbackInteractiveRows": 131,
  "sample": { "pid": 78032, "cwd": "/Users/fongy/storehub/brain", "name": "walle-r2d2" }
}
```

130 interactive rows through the CLI (above the expected 50). File fallback sees one more (the registry is live; counts drift between reads). The brief's `require('./dist/extension.js')` export print cannot run outside VS Code (vscode external); not run.

## Not verified

The live end-to-end in VS Code (start `claude` in a managed terminal with no hook, state.json within 2 s) was not run: it needs the packaged extension installed in a running VS Code. The U5 tests cover the same path with a real temp dir, a real `fs.watch` write, and the real `adoptWithSessionId` + state.json write (500 ms tick). The `~/.claude/settings.json` hook (line 175) is still present; the lane removes it after landing.
