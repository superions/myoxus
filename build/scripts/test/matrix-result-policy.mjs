// SPDX-License-Identifier: AGPL-3.0-or-later

/** Preserve command failures even when the same run exceeds its time budget. */
export function suiteExitCode(result, budgetFailure) {
  if (result.timedOut) return 124;
  const commandExitCode = result.status ?? 1;
  if (commandExitCode !== 0) return commandExitCode;
  return budgetFailure ? 125 : 0;
}

export function classifyBlockingResult(result, blockingMode) {
  if (result.exitCode === 0 || blockingMode === "report-only") {
    return { shouldContinue: true, exitCode: 0 };
  }
  if (result.exitCode === 125) {
    return { shouldContinue: true, exitCode: 125 };
  }
  return { shouldContinue: false, exitCode: result.exitCode };
}
