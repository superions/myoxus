// SPDX-License-Identifier: AGPL-3.0-or-later

export const DEFAULT_VITEST_DIAGNOSTIC_TIMEOUT_SECONDS = 300;
export const DIRECT_VITEST_MAX_WORKERS = 8;

export class VitestDiagnosticUsageError extends Error {}

function workerCount(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--maxWorkers" || argument === "--max-workers") {
      return Number(args[index + 1]);
    }
    const match = argument.match(/^--max(?:W|w)orkers=(\d+)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

function isBoundedRun(args) {
  return args[0] === "run" || args.includes("--run");
}

function hasScope(args) {
  const runIndex = args[0] === "run" ? 0 : args.indexOf("--run");
  return args.slice(runIndex + 1).some((argument, index, tail) => {
    if (argument === "--project" || argument === "--config") {
      return Boolean(tail[index + 1]);
    }
    return !argument.startsWith("-");
  });
}

export function createVitestDiagnosticContract(
  vitestArgs,
  { matrixSuiteId = null } = {},
) {
  if (vitestArgs.length === 0) {
    throw new VitestDiagnosticUsageError("missing Vitest arguments");
  }
  const boundedRun = isBoundedRun(vitestArgs);
  const configuredWorkers = workerCount(vitestArgs);
  if (boundedRun && !hasScope(vitestArgs)) {
    throw new VitestDiagnosticUsageError(
      "refusing an unscoped Vitest run; pass a path, --project or --config",
    );
  }
  if (
    !matrixSuiteId &&
    configuredWorkers !== null &&
    (!Number.isSafeInteger(configuredWorkers) ||
      configuredWorkers <= 0 ||
      configuredWorkers > DIRECT_VITEST_MAX_WORKERS)
  ) {
    throw new VitestDiagnosticUsageError(
      `direct runs may use at most ${DIRECT_VITEST_MAX_WORKERS} workers`,
    );
  }

  return {
    args:
      boundedRun && configuredWorkers === null
        ? [...vitestArgs, "--maxWorkers=8"]
        : vitestArgs,
    boundedRun,
    command: "node (installed Vitest CLI)",
    matrixSuiteId,
    timeoutSeconds: matrixSuiteId
      ? null
      : DEFAULT_VITEST_DIAGNOSTIC_TIMEOUT_SECONDS,
  };
}
