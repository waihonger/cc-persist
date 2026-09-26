Completed B3 in `test/registryWatcher.test.ts` and `test/__mocks__/vscode.ts`.

Fixed the fixtures and added 10 cases covering payload changes, in-flight rewrites, debounce limits, environment cleanup, stale timestamps, PID timeouts, and foreign-row handling. Negative controls remain intact.

Watch events are mocked; temporary file reads/writes and activation persistence remain real.

Passed twice consecutively:

- Focused suite: **72 tests**
- Full suite: **271 tests, 0 failures**

No source edits or git commands.