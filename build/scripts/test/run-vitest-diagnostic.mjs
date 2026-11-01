#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { runWithProcessTreeTimeout } from "./process-tree-runner.mjs";
import {
  createVitestDiagnosticContract,
  DEFAULT_VITEST_DIAGNOSTIC_TIMEOUT_SECONDS,
  VitestDiagnosticUsageError,
} from "./vitest-diagnostic-contract.mjs";

const invocationCwd = resolve(process.env.INIT_CWD ?? process.cwd());

function fail(message) {
  console.error(`vitest diagnostic: ${message}`);
  process.exit(2);
}

function runInsideMatrix(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestEntrypoint, ...args], {
      // Matrix suites use cwd as part of their ownership contract. Preserving
      // it keeps package-local config and include paths from resolving at root.
      cwd: invocationCwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", (error) => resolve({ error, status: 1 }));
    child.once("close", (status, signal) => resolve({ signal, status }));
  });
}

const rawArgs = process.argv.slice(2);
const separator = rawArgs.indexOf("--");
const wrapperArgs = separator >= 0 ? rawArgs.slice(0, separator) : [];
const vitestArgs = separator >= 0 ? rawArgs.slice(separator + 1) : rawArgs;
const dryRun = wrapperArgs.includes("--dry-run");
if (wrapperArgs.some((argument) => argument !== "--dry-run")) {
  fail("only --dry-run is accepted before --");
}
const matrixSuiteId = process.env.MYOXUS_MATRIX_SUITE_ID || null;
let contract;
try {
  contract = createVitestDiagnosticContract(vitestArgs, { matrixSuiteId });
} catch (error) {
  if (error instanceof VitestDiagnosticUsageError) fail(error.message);
  throw error;
}
if (dryRun) {
  console.log(JSON.stringify(contract, null, 2));
  process.exit(0);
}

// Use the installed pinned CLI directly. A second package-manager startup
// adds cost to every suite without changing its cwd, arguments or ownership.
const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve("vitest/package.json");
const vitestPackage = JSON.parse(readFileSync(vitestPackagePath, "utf8"));
const vitestBin =
  typeof vitestPackage.bin === "string"
    ? vitestPackage.bin
    : vitestPackage.bin?.vitest;
if (!vitestBin)
  throw new Error("Installed Vitest package has no CLI entrypoint");
const vitestEntrypoint = resolve(dirname(vitestPackagePath), vitestBin);

if (matrixSuiteId) {
  // The matrix runner already owns the complete process group and timeout.
  // Keeping Vitest in that group avoids an independently orphanable subtree.
  const result = await runInsideMatrix(contract.args);
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

if (!contract.boundedRun) {
  const result = await runInsideMatrix(contract.args);
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

const result = await runWithProcessTreeTimeout(
  process.execPath,
  [vitestEntrypoint, ...contract.args],
  {
    cwd: invocationCwd,
    env: process.env,
    stdio: "inherit",
    timeoutMs: DEFAULT_VITEST_DIAGNOSTIC_TIMEOUT_SECONDS * 1000,
  },
);
if (result.timedOut) {
  console.error(
    `vitest diagnostic: exceeded ${DEFAULT_VITEST_DIAGNOSTIC_TIMEOUT_SECONDS}s; complete process group terminated`,
  );
}
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
