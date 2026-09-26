Completed U3 in the three allowed files:

- Added boolean `cc-persist.notifications`, default `false`.
- Added status tracking that skips first sightings and forgets vanished PIDs.
- Cached adopted terminals and added busy→idle / busy→waiting toasts, with “Show” focusing the terminal. The setting is reread on every status event.

Public, settable callback on `RegistryWatcher`:

```ts
public onStatusChange?: (
  pid: number,
  from: string | undefined,
  to: string | undefined,
  row: RegistryRow,
) => void;
```

All checks passed twice consecutively: compile, TypeScript, package setting validation, and **199 tests across 8 files**.

No tests added; no git commands ran.