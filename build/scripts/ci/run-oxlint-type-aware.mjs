#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const yarnCli = join(repoRoot, ".yarn/releases/yarn-4.18.0.cjs");
const typeScriptSource = /\.(?:ts|tsx|cts|mts)$/;
const declarationSource = /\.d\.(?:ts|cts|mts)$/;
const testScope =
  /(^scripts\/|\/(?:__tests__|tests|benchmark|__debug__|e2e)\/|\.(?:spec|test)\.(?:ts|tsx|cts|mts)$|\.stories\.tsx$)/;

function selectedScope(path) {
  return (
    typeScriptSource.test(path) &&
    !declarationSource.test(path) &&
    (path.startsWith("tools/") || testScope.test(path))
  );
}

export function readNullDelimitedProcess(command, arguments_, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const stderrLimit = options.stderrLimit ?? 64 * 1024;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entries = [];
    let remainder = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const parts = `${remainder}${chunk}`.split("\0");
      remainder = parts.pop() ?? "";
      for (const part of parts) {
        if (part) entries.push(part);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < stderrLimit) {
        stderr += chunk.slice(0, stderrLimit - stderr.length);
      }
    });
    child.on("error", (error) => {
      rejectPromise(
        new Error(`Unable to start ${command}: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.on("close", (status, signal) => {
      if (status !== 0) {
        const outcome = signal ? `signal ${signal}` : `exit ${status}`;
        rejectPromise(
          new Error(
            `${command} inventory failed (${outcome}): ${stderr.trim() || "no stderr output"}`,
          ),
        );
        return;
      }
      if (remainder) entries.push(remainder);
      resolvePromise(entries.sort());
    });
  });
}

function repositoryFiles() {
  return readNullDelimitedProcess("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
}

function runRules(label, rules, files) {
  if (!files.length) throw new Error(`${label} selected no files`);
  const arguments_ = [
    yarnCli,
    "exec",
    "oxlint",
    "--type-aware",
    "-A",
    "all",
    "--quiet",
    ...rules.flatMap((rule) => ["-D", rule]),
    ...files,
  ];
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runSelectionSelfTest() {
  assert.equal(selectedScope("tools/cli/src/build.ts"), true);
  assert.equal(selectedScope("client/libs/core/src/value.spec.ts"), true);
  assert.equal(selectedScope("virgultum/editor/src/__tests__/value.ts"), true);
  assert.equal(selectedScope("client/libs/core/src/value.ts"), false);
  assert.equal(selectedScope("tools/types/value.d.ts"), false);
  return [
    "tools",
    "spec",
    "nested-test",
    "production-exclusion",
    "declaration-exclusion",
  ];
}

export async function runInventorySelfTest() {
  const entryCount = 20_000;
  const script = `const suffix = "x".repeat(96); for (let index = 0; index < ${entryCount}; index += 1) process.stdout.write(index + "-" + suffix + ".ts\\0");`;
  const entries = await readNullDelimitedProcess(process.execPath, [
    "--input-type=commonjs",
    "--eval",
    script,
  ]);
  assert.equal(entries.length, entryCount);
  assert.equal(entries[0], `0-${"x".repeat(96)}.ts`);
  await assert.rejects(
    readNullDelimitedProcess("myoxus-missing-inventory-command", []),
    /Unable to start myoxus-missing-inventory-command:.*ENOENT/,
  );
  return ["streamed-inventory-over-1MiB", "missing-command-diagnostic"];
}

const selfTests = runSelectionSelfTest();
if (process.argv.includes("--self-test")) {
  selfTests.push(...(await runInventorySelfTest()));
  console.log(
    `Oxlint type-aware selection self-tests: ${selfTests.join(", ")}`,
  );
  process.exit(0);
}

const files = await repositoryFiles();
const selected = files.filter(selectedScope);
const tools = selected.filter((path) => path.startsWith("tools/"));
const toolProduction = tools.filter((path) => !testScope.test(path));

runRules(
  "type-aware test/tooling correctness",
  ["typescript/return-await", "typescript/no-floating-promises"],
  selected,
);
runRules(
  "type-aware tooling correctness",
  ["typescript/await-thenable", "typescript/require-array-sort-compare"],
  tools,
);
runRules(
  "type-aware tooling promise callbacks",
  ["typescript/no-misused-promises"],
  toolProduction,
);

console.log(
  `Oxlint type-aware gates passed (${selected.length} test/tooling files; ${tools.length} tooling files).`,
);
