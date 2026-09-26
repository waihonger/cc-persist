Implemented B2 in `src/registryWatcher.ts` and `src/extension.ts`. Compile and TypeScript passed twice consecutively.

Added payload-based re-adoption, `startedAt` validation through `isLiveClaudePid`, a two-second debounce cap, activation environment cleanup, bounded terminal PID resolution, and cached foreign outcomes with one aggregate log per reconcile.

Exact callback signature:

```ts
onRow: (
  pid: number,
  sessionId: string,
  cwd: string | undefined,
  procs: Promise<Map<number, ProcEntry>>,
  startedAt: number | undefined,
) => Promise<PidSessionOutcome>
```

```ts
type PidSessionOutcome =
  | "adopted"
  | "retry"
  | "discard"
  | "foreign";
```

Events received during adoption immediately queue another reconcile. After adoption finishes, that reconcile rereads the registry and compares against the payload actually adopted, re-adopting changed UUIDs or working directories.

`npm test`: **249 passed, 12 failed**, all in `test/registryWatcher.test.ts`:

- Startup/adopt-once test: expects the old four-argument callback.
- Filesystem-write adoption, burst debounce, and busy→idle callback tests: expected events did not arrive.
- All eight notification tests: activation fixture lacks `environmentVariableCollection`.

Tests and `pidResolver.ts` were untouched. No git commands ran.