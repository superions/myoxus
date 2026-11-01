import { describe, expect, test, vi } from "vitest";

import { BuildCommand } from "./build";
import { RunCommand } from "./run";
import type { Package } from "@myoxus-tools/utils/workspace";

function commandWithNestedExitCode(exitCode: number) {
  const command = new BuildCommand();
  Object.defineProperties(command, {
    cli: { value: { run: vi.fn().mockResolvedValue(exitCode) } },
    package: { value: "@myoxus/web" },
  });
  return command;
}

describe("BuildCommand", () => {
  test("propagates a failed nested package build", async () => {
    await expect(commandWithNestedExitCode(1).execute()).rejects.toThrow(
      "Build failed for @myoxus/web with exit code 1.",
    );
  });

  test("accepts a successful nested package build", async () => {
    await expect(
      commandWithNestedExitCode(0).execute(),
    ).resolves.toBeUndefined();
  });
});

describe("workspace build scripts", () => {
  test.each([1])("propagates nested script result %s", async (exitCode) => {
    const command = new RunCommand();
    Object.defineProperty(command, "cli", {
      value: { run: vi.fn().mockResolvedValue(exitCode) },
    });
    const pkg = {
      name: "@myoxus/web",
      scripts: { build: "myoxus bundle" },
    } as unknown as Package;
    const environment = process.env;
    try {
      const result = command.runScript(pkg, "build", [], {});
      if (exitCode === 0) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow(
          "Script build failed for @myoxus/web with exit code 1.",
        );
      }
    } finally {
      process.env = environment;
    }
  });
});
