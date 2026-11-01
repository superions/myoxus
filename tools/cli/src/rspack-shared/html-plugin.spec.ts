import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("build revision", () => {
  let directory: string;

  beforeEach(() => {
    vi.resetModules();
    directory = mkdtempSync(join(tmpdir(), "myoxus-build-revision-"));
    vi.doMock("@myoxus-tools/utils/path", async () => {
      const actual = await vi.importActual<
        typeof import("@myoxus-tools/utils/path")
      >("@myoxus-tools/utils/path");
      return { ...actual, ProjectRoot: new actual.Path(directory) };
    });
    vi.stubEnv("GITHUB_SHA", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@myoxus-tools/utils/path");
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  test("CI SHA takes precedence and the result stays cached", async () => {
    vi.stubEnv("GITHUB_SHA", "123456789abcdef");
    const { getBuildRevision } = await import("./html-plugin");
    expect(getBuildRevision()).toBe("123456789");
    vi.stubEnv("GITHUB_SHA", "changed");
    expect(getBuildRevision()).toBe("123456789");
  });

  test("reads nine characters from the project checkout outside process CWD", async () => {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git(["init"]);
    git([
      "-c",
      "user.name=Build fixture",
      "-c",
      "user.email=build@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const expected = git(["rev-parse", "HEAD"]).slice(0, 9);
    expect(process.cwd()).not.toBe(directory);
    const { getBuildRevision } = await import("./html-plugin");
    expect(getBuildRevision()).toBe(expected);
  });

  test("source archive without repository metadata uses localdev", async () => {
    const { getBuildRevision } = await import("./html-plugin");
    expect(getBuildRevision()).toBe("localdev");
  });

  test("missing Git executable uses localdev", async () => {
    const { getBuildRevision } = await import("./html-plugin");
    vi.stubEnv("PATH", directory);
    expect(getBuildRevision()).toBe("localdev");
  });
});
