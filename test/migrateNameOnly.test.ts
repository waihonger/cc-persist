import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve("scripts/migrate-name-only.py");
const SID_A = "11111111-1111-4111-8111-111111111111";
const SID_B = "22222222-2222-4222-8222-222222222222";
const tempDirs: string[] = [];

function tempDir(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-migrate-"));
  tempDirs.push(result);
  return result;
}

function workspaceId(folder: string): string {
  const absolute = path.resolve(folder);
  const base = path.basename(absolute) || "vscode";
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^-+/, "").slice(0, 32) || "vscode";
  const hash = crypto.createHash("sha256").update(absolute).digest("hex").slice(0, 6);
  return `${sanitized.slice(0, 25)}-${hash}`;
}

function runScript(
  root: string,
  projects: string,
  cache: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(
    "python3",
    [SCRIPT, "--root", root, "--projects", projects, "--cache", cache, ...extraArgs],
    { encoding: "utf8", env },
  );
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrate-name-only.py", () => {
  it("disambiguates duplicate titles by the first transcript cwd", () => {
    const base = tempDir();
    const root = path.join(base, "state");
    const projects = path.join(base, "projects");
    const wantedCwd = path.join(base, "wanted workspace");
    const otherCwd = path.join(base, "other workspace");
    const workspace = workspaceId(wantedCwd);
    fs.mkdirSync(path.join(root, workspace), { recursive: true });
    fs.mkdirSync(path.join(projects, "one"), { recursive: true });
    fs.writeFileSync(
      path.join(root, workspace, "state.json"),
      JSON.stringify({ version: 1, terminals: [{ index: 7, name: "shared" }] }),
    );
    fs.writeFileSync(path.join(projects, "one", `${SID_A}.jsonl`), `${JSON.stringify({ cwd: wantedCwd })}\n`);
    fs.writeFileSync(path.join(projects, "one", `${SID_B}.jsonl`), `${JSON.stringify({ cwd: otherCwd })}\n`);
    const cache = path.join(base, "titles.txt");
    fs.writeFileSync(
      cache,
      [SID_A, SID_B]
        .map((sid) => `"type":"custom-title","customTitle":"shared","sessionId":"${sid}"`)
        .join("\n"),
    );

    const result = runScript(root, projects, cache, ["--force"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${workspace} | 1 | 1 | 1 | 0 | 0 | updated`);
    expect(JSON.parse(fs.readFileSync(path.join(root, workspace, "state.json"), "utf8"))).toEqual({
      version: 2,
      terminals: [{ index: 7, sessionId: SID_A, name: "shared" }],
    });
  });

  it("leaves unknown state versions untouched", () => {
    const base = tempDir();
    const root = path.join(base, "state");
    const projects = path.join(base, "projects");
    const workspace = "unknown-version";
    fs.mkdirSync(path.join(root, workspace), { recursive: true });
    fs.mkdirSync(projects, { recursive: true });
    const statePath = path.join(root, workspace, "state.json");
    const original = JSON.stringify({ version: 3, terminals: [{ index: 1, name: "old" }] });
    fs.writeFileSync(statePath, original);
    const cache = path.join(base, "titles.txt");
    fs.writeFileSync(cache, "");

    const result = runScript(root, projects, cache, ["--force"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${workspace} | 0 | 0 | 0 | 0 | 0 | skipped (unknown version)`);
    expect(fs.readFileSync(statePath, "utf8")).toBe(original);
  });

  it("reports an unwritable state and still prints totals", () => {
    const base = tempDir();
    const root = path.join(base, "state");
    const projects = path.join(base, "projects");
    const workspaceDir = path.join(root, "unwritable-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "state.json"),
      JSON.stringify({ version: 1, terminals: [{ index: 1, name: "missing" }] }),
    );
    const cache = path.join(base, "titles.txt");
    fs.writeFileSync(cache, "");
    fs.chmodSync(workspaceDir, 0o555);

    const result = runScript(root, projects, cache, ["--force"]);
    fs.chmodSync(workspaceDir, 0o755);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("unwritable-workspace | 1 | 0 | 0 | 0 | 1 | skipped (unwritable)");
    expect(result.stdout).toContain("TOTALS | 1 | 0 | 0 | 0 | 1 |");
  });

  it("requires parseable window state only while VS Code is running", () => {
    const base = tempDir();
    const root = path.join(base, "state");
    const projects = path.join(base, "projects");
    const fakeBin = path.join(base, "bin");
    const home = path.join(base, "home");
    const storage = path.join(home, "Library/Application Support/Code/User/globalStorage/storage.json");
    const cache = path.join(base, "titles.txt");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(projects, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(path.dirname(storage), { recursive: true });
    fs.writeFileSync(cache, "");
    fs.writeFileSync(storage, "not json");
    const ps = path.join(fakeBin, "ps");
    fs.writeFileSync(ps, "#!/bin/sh\nprintf '%s\\n' '/Applications/Visual Studio Code.app/Contents/MacOS/Code'\n");
    fs.chmodSync(ps, 0o755);
    const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` };

    const guarded = runScript(root, projects, cache, [], env);
    expect(guarded.status).toBe(2);
    expect(guarded.stderr).toContain("VS Code is running but storage.json cannot be parsed");

    const forced = runScript(root, projects, cache, ["--force"], env);
    expect(forced.status, forced.stderr).toBe(0);

    fs.writeFileSync(ps, "#!/bin/sh\nexit 0\n");
    const stopped = runScript(root, projects, cache, [], env);
    expect(stopped.status, stopped.stderr).toBe(0);
  });
});
