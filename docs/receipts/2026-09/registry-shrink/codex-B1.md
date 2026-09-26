Completed B1 in the two allowed files.

- `startedAt` is preserved only when finite and positive.
- CLI reads use `SIGKILL` at the five-second timeout, plus an independent six-second deadline that kills the child and triggers file fallback.
- Injected readers retain their existing API.

All checks passed twice consecutively: **48 tests**, compile, and TypeScript.

Exact shape:

```ts
export interface RegistryRow {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  startedAt?: number;
  kind: "interactive" | "background";
}
```

`startedAt` is in milliseconds. No git commands ran.