Added 47 U5 tests across `test/sessionRegistry.test.ts` and `test/registryWatcher.test.ts`, including the empty-registry negative control. Updated VS Code toast mocks to return promises.

Notification tests call real `activate`, suppress OS watch startup, and invoke the public status callback. No toast logic is duplicated. No source edits or git commands.

`npm test`: **242 passed, 4 failed**. Failures cover filesystem-event adoption, debounce, and status changes. Two consecutive green runs could not be completed.

BLOCKED: filesystem watcher verification — a standalone `fs.watch` probe returns `EMFILE: too many open files, watch`. Orchestrator action needed: restore working filesystem watches, then rerun the focused and full suites twice.