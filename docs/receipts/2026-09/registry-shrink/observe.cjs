"use strict";

const { performance } = require("node:perf_hooks");
const { readRegistry, resolveSessionsDir } = require("./sessionRegistry.cjs");

async function observe() {
  const sessionsDir = resolveSessionsDir();
  const started = performance.now();
  // The normal reader tries the CLI first and retains its built-in fallback.
  const cliRows = await readRegistry({ sessionsDir });
  const cliElapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  const fileRows = await readRegistry({
    sessionsDir,
    runAgents: async () => { throw new Error("Force read-only file fallback"); },
  });
  const rows = [...cliRows, ...fileRows];
  const sample = rows.find((row) => row.cwd && row.name) ?? rows[0];

  console.log(JSON.stringify({
    sessionsDir,
    cliInteractiveRows: cliRows.length,
    cliElapsedMs,
    fileFallbackInteractiveRows: fileRows.length,
    sample: sample ? {
      pid: sample.pid,
      cwd: sample.cwd ?? null,
      name: sample.name ?? null,
    } : null,
  }, null, 2));
}

observe().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
