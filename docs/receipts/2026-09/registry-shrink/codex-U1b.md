Updated `readRegistry` to fall back to files when the CLI yields zero valid interactive rows. Tests now cover empty, background-only, and invalid-only arrays, and confirm valid CLI results never read files.

Passed twice: **35 focused tests**, compile, and TypeScript checks.

STOP: `npm test` failed twice with the same four filesystem-event failures in `test/registryWatcher.test.ts` (**244 passed, 4 failed**). That file is outside this fix’s scope; full verification remains incomplete.

Only the two requested files were edited. No git commands ran.