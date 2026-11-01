#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import process from "node:process";
import { availableParallelism } from "node:os";

import { runWithProcessTreeTimeout } from "./process-tree-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const DEFAULT_CARGO_JOBS = "8";
const SUPPORTED_COMMANDS = new Set(["build", "check", "clippy", "test"]);

function fail(message) {
  console.error(`cargo diagnostic: ${message}`);
  process.exit(2);
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let dryRun = false;
  let json = false;
  let index = 0;

  while (index < argv.length && argv[index] !== "--") {
    const argument = argv[index];
    if (argument === "--timeout-seconds") {
      const value = argv[index + 1];
      if (value === undefined) fail("--timeout-seconds requires a value");
      timeoutSeconds = parsePositiveInteger(value, "--timeout-seconds");
      index += 2;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      index += 1;
      continue;
    }
    fail(`unknown option ${argument}; place Cargo arguments after --`);
  }

  if (argv[index] !== "--") fail("missing -- before Cargo arguments");
  const cargoArgs = argv.slice(index + 1);
  if (cargoArgs.length === 0) fail("missing Cargo command");
  if (!SUPPORTED_COMMANDS.has(cargoArgs[0])) {
    fail(
      `unsupported Cargo command ${cargoArgs[0]}; use build, check, clippy or test`,
    );
  }
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    fail(`--timeout-seconds must not exceed ${MAX_TIMEOUT_SECONDS}`);
  }
  if (
    cargoArgs.some(
      (argument) =>
        argument === "-j" ||
        /^-j\d+$/.test(argument) ||
        argument === "--jobs" ||
        argument.startsWith("--jobs=") ||
        argument === "--config" ||
        argument.startsWith("--config="),
    )
  ) {
    fail(
      "job and Cargo config overrides are not allowed in bounded diagnostics",
    );
  }
  if (json && !dryRun) fail("--json is supported only with --dry-run");

  return { cargoArgs, dryRun, json, timeoutSeconds };
}

const options = parseArguments(process.argv.slice(2));
const cargoJobs = String(
  parsePositiveInteger(
    process.env.CARGO_BUILD_JOBS ?? DEFAULT_CARGO_JOBS,
    "CARGO_BUILD_JOBS",
  ),
);
if (
  process.env.CARGO_BUILD_JOBS !== undefined &&
  Number(cargoJobs) > availableParallelism()
) {
  fail("CARGO_BUILD_JOBS must not exceed the available CPU count");
}
const contract = {
  command: "cargo",
  args: options.cargoArgs,
  cwd: repoRoot,
  timeoutSeconds: options.timeoutSeconds,
  environment: {
    CARGO_BUILD_JOBS: cargoJobs,
    CARGO_INCREMENTAL: "0",
  },
};

if (options.dryRun) {
  if (options.json) console.log(JSON.stringify(contract, null, 2));
  else {
    console.log(
      `${contract.command} ${contract.args.join(" ")} ` +
        `(timeout=${contract.timeoutSeconds}s, jobs=${cargoJobs}, incremental=0)`,
    );
  }
  process.exit(0);
}

const result = await runWithProcessTreeTimeout("cargo", options.cargoArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    CARGO_BUILD_JOBS: cargoJobs,
    CARGO_INCREMENTAL: "0",
  },
  stdio: "inherit",
  timeoutMs: options.timeoutSeconds * 1000,
});

if (result.timedOut) {
  console.error(
    `cargo diagnostic exceeded ${options.timeoutSeconds}s; complete process group terminated`,
  );
} else if (result.error) {
  console.error(`cargo diagnostic failed to start: ${result.error.message}`);
}

process.exitCode = result.timedOut ? 124 : (result.status ?? 1);
