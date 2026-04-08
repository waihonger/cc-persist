import { describe, it, expect } from "vitest";
import { sanitizeName, resolveWorkspaceId, resolveStateDir, resolveSignalBaseDir } from "../src/config";
import * as os from "os";
import * as path from "path";

describe("sanitizeName", () => {
  it("passes through simple names", () => {
    expect(sanitizeName("my-project")).toBe("my-project");
    expect(sanitizeName("foo_bar")).toBe("foo_bar");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeName("my project")).toBe("my_project");
    expect(sanitizeName("foo.bar")).toBe("foo_bar");
    expect(sanitizeName("a:b:c")).toBe("a_b_c");
  });

  it("strips leading dashes", () => {
    expect(sanitizeName("-leading")).toBe("leading");
    expect(sanitizeName("---multi")).toBe("multi");
  });

  it("truncates to 32 characters", () => {
    expect(sanitizeName("a".repeat(50))).toBe("a".repeat(32));
  });

  it("returns 'vscode' for empty input", () => {
    expect(sanitizeName("")).toBe("vscode");
    expect(sanitizeName("---")).toBe("vscode");
  });
});

describe("resolveWorkspaceId", () => {
  it("returns folder name with hash suffix", () => {
    const id = resolveWorkspaceId();
    expect(id).toMatch(/^my-project-[a-f0-9]{6}$/);
  });
});

describe("resolveStateDir", () => {
  it("returns persistent path under home directory", () => {
    const dir = resolveStateDir();
    expect(dir).toBe(path.join(os.homedir(), ".cc-persist", resolveWorkspaceId()));
  });
});

describe("resolveSignalBaseDir", () => {
  it("returns tmpdir-based path", () => {
    const dir = resolveSignalBaseDir();
    expect(dir).toMatch(/dtach-persist/);
    expect(dir).toContain(resolveWorkspaceId());
  });
});
