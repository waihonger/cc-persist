Implemented U2’s registry watcher, extension wiring, signal setup removal, and affected test updates. Restore commands and metadata handling remain unchanged.

Compile passed; all 199 tests passed. TypeScript and the source scan fail only because `src/sidWatcher.ts` remains. Two consecutive verification passes were not achieved. No git commands ran.

BLOCKED: deleting `src/sidWatcher.ts` — `trash` exited 1 without diagnostics. Orchestrator action needed: trash that file, then rerun all four checks twice.