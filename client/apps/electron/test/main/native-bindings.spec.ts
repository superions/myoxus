import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function expectNativeExports(bindingPath: string, exports: string[]) {
  const script = `
    const binding = require(${JSON.stringify(bindingPath)});
    const names = ${JSON.stringify(exports)};
    for (const name of names) {
      if (typeof binding[name] !== "function") {
        throw new Error("Missing native function export " + name);
      }
    }
    process.stdout.write("native-exports-ok");
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
  });
  expect({
    error: result.error?.message,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }).toEqual({
    error: undefined,
    signal: null,
    status: 0,
    stderr: "",
    stdout: "native-exports-ok",
  });
}

describe("native bindings", () => {
  test("@myoxus/local-store exposes NAPI constructors", () => {
    expectNativeExports(
      `${repoRoot}/client/libs/local-store/native-binding.cjs`,
      ["DocStorage", "DocStoragePool"],
    );
  });

  test("@myoxus/media-capture exposes capture, not only decoder bindings", () => {
    expectNativeExports(
      `${repoRoot}/client/libs/media-capture/myoxus_media.node`,
      ["ShareableContent"],
    );
  });
});
