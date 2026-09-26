import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseRegistryRow, readRegistry, resolveSessionsDir } from "../src/sessionRegistry";

const sample = {
  pid: 88212,
  sessionId: "293788ff-5f8c-483b-922b-f8a5c749e9d6",
  cwd: "/Users/fongy/storehub/brain",
  startedAt: 1790397130389,
  version: "2.1.283",
  kind: "interactive",
  entrypoint: "cli",
  messagingSocketPath: "/tmp/cc-socks/88212.sock",
  name: "ccpersist-research",
  nameSource: "user",
  status: "busy",
  updatedAt: 1790399089786,
};
const expected = {
  pid: sample.pid, sessionId: sample.sessionId, cwd: sample.cwd,
  kind: "interactive", name: sample.name, status: sample.status,
};

describe("parseRegistryRow", () => {
  it("accepts the sample interactive row and selects supported fields", () => {
    expect(parseRegistryRow(sample)).toEqual(expected);
  });

  it("defaults missing kind to interactive and ignores non-string optional fields", () => {
    expect(parseRegistryRow({ pid: sample.pid, sessionId: sample.sessionId, cwd: 1, name: null, status: false }))
      .toEqual({ pid: sample.pid, sessionId: sample.sessionId, kind: "interactive" });
  });

  it.each(["background", "unknown", null])("rejects kind %s", (kind) => {
    expect(parseRegistryRow({ ...sample, kind })).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "88212", null, undefined])
    ("rejects invalid pid %s", (pid) => {
      expect(parseRegistryRow({ ...sample, pid })).toBeNull();
    });

  it.each(["short", "z93788ff-5f8c-483b-922b-f8a5c749e9d6", "293788ff5f8c483b922bf8a5c749e9d6", null, 42])
    ("rejects invalid session ID %s", (sessionId) => {
      expect(parseRegistryRow({ ...sample, sessionId })).toBeNull();
    });

  it.each([null, undefined, [], "row", 42])("rejects non-row input %s", (raw) => {
    expect(parseRegistryRow(raw)).toBeNull();
  });
});

describe("resolveSessionsDir", () => {
  it("honors CLAUDE_CONFIG_DIR", () => {
    expect(resolveSessionsDir({ CLAUDE_CONFIG_DIR: "/tmp/custom-claude" }, "/tmp/home"))
      .toBe("/tmp/custom-claude/sessions");
  });

  it("defaults to the home .claude directory", () => {
    expect(resolveSessionsDir({}, "/tmp/home")).toBe("/tmp/home/.claude/sessions");
  });
});

describe("readRegistry", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-persist-registry-reader-"));
    fs.writeFileSync(path.join(sessionsDir, `${sample.pid}.json`), JSON.stringify(sample));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of fs.readdirSync(sessionsDir)) fs.unlinkSync(path.join(sessionsDir, file));
    fs.rmdirSync(sessionsDir);
  });

  it("uses injected agents JSON instead of falling back to files", async () => {
    const readdir = vi.spyOn(fs.promises, "readdir");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const cliRow = { ...sample, pid: 44584, name: "cli-session" };
    const runAgents = vi.fn().mockResolvedValue(JSON.stringify([
      cliRow, { ...sample, kind: "background" }, { ...sample, pid: -1 },
    ]));

    expect(await readRegistry({ sessionsDir, runAgents }))
      .toEqual([{ ...expected, pid: 44584, name: "cli-session" }]);
    expect(runAgents).toHaveBeenCalledExactlyOnceWith();
    expect(readdir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back when the command throws, skipping malformed and unrelated files", async () => {
    fs.writeFileSync(path.join(sessionsDir, "1.json"), "{partial");
    fs.writeFileSync(path.join(sessionsDir, "2.json"), JSON.stringify({ ...sample, kind: "background" }));
    fs.writeFileSync(path.join(sessionsDir, "3.json"), JSON.stringify({ ...sample, sessionId: "short" }));
    fs.writeFileSync(path.join(sessionsDir, "notes.json"), JSON.stringify({ ...sample, pid: 4 }));
    fs.writeFileSync(path.join(sessionsDir, "5.key"), JSON.stringify({ ...sample, pid: 5 }));
    const before = fs.readdirSync(sessionsDir).map(file => [file, fs.readFileSync(path.join(sessionsDir, file), "utf8")]);

    expect(await readRegistry({ sessionsDir, runAgents: async () => { throw new Error("CLI unavailable"); } }))
      .toEqual([expected]);
    expect(fs.readdirSync(sessionsDir).map(file => [file, fs.readFileSync(path.join(sessionsDir, file), "utf8")]))
      .toEqual(before);
  });

  it.each(["", "not JSON", "{}"])("falls back for unusable command output %j", async (output) => {
    expect(await readRegistry({ sessionsDir, runAgents: async () => output })).toEqual([expected]);
  });

  it.each([
    { label: "empty", rows: [] },
    { label: "background-only", rows: [{ ...sample, kind: "background" }] },
    { label: "invalid-only", rows: [{ ...sample, pid: -1 }] },
  ])("falls back to files for an $label CLI array", async ({ rows }) => {
    expect(await readRegistry({ sessionsDir, runAgents: async () => JSON.stringify(rows) }))
      .toEqual([expected]);
  });

  it("returns no rows when the command fails and the directory is missing", async () => {
    const missing = path.join(sessionsDir, "missing");
    expect(await readRegistry({ sessionsDir: missing, runAgents: async () => { throw new Error("missing CLI"); } }))
      .toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
  });
});
