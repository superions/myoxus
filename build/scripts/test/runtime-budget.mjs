// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Evaluates one measured runtime against the declared budget and its shared
 * fluctuation band. The declared budget remains the review baseline; the band
 * only prevents ordinary host variance from becoming a strict failure.
 */
export function evaluateRuntimeBudget(
  elapsedMs,
  budget,
  fluctuationTolerancePercent,
) {
  if (!budget || !Number.isFinite(elapsedMs)) return null;

  const baselineMs = Number(budget.baseline_ms);
  const warnBudgetMs = Number(budget.warn_budget_ms);
  const strictBudgetMs = Number(budget.strict_budget_ms);
  const toleranceMultiplier = 1 + fluctuationTolerancePercent / 100;
  const warnToleranceCeilingMs = warnBudgetMs * toleranceMultiplier;
  const strictToleranceCeilingMs = strictBudgetMs * toleranceMultiplier;
  const rawWarnExceeded = elapsedMs > warnBudgetMs;
  const rawStrictExceeded = elapsedMs > strictBudgetMs;
  const warnExceeded = elapsedMs > warnToleranceCeilingMs;
  const strictExceeded = elapsedMs > strictToleranceCeilingMs;

  const status = strictExceeded
    ? "strict-exceeded"
    : rawStrictExceeded
      ? "strict-fluctuation-tolerated"
      : warnExceeded
        ? "warn-exceeded"
        : rawWarnExceeded
          ? "warn-fluctuation-tolerated"
          : "within";

  return {
    status,
    baselineMs,
    warnBudgetMs,
    strictBudgetMs,
    fluctuationTolerancePercent,
    warnToleranceCeilingMs,
    strictToleranceCeilingMs,
    rawWarnExceeded,
    rawStrictExceeded,
    warnExceeded,
    strictExceeded,
    toleratedFluctuation: status.endsWith("fluctuation-tolerated"),
    sourceArtifact: budget.source_artifact,
    costCenter: budget.cost_center,
    decision: budget.decision,
  };
}
