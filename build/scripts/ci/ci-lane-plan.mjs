// SPDX-License-Identifier: AGPL-3.0-or-later

const frontend = /^(?:client|virgultum)\/|^(?:package\.json|yarn\.lock)$/;
const testSource = /(?:\.(?:spec|test)\.[cm]?[jt]sx?$|^tests\/)/;

export function prChecks(files, base) {
  const checks = [
    {
      id: "diff",
      command: "git",
      args: ["--no-pager", "diff", "--check", base, "HEAD"],
    },
    {
      id: "workflow-lanes",
      command: "node",
      args: ["build/scripts/ci/verify-workflow-lanes.mjs"],
    },
  ];
  if (files.some((file) => /\.[cm]?[jt]sx?$/.test(file))) {
    checks.push({
      id: "lint.oxlint.changed",
      command: "node",
      args: ["build/scripts/ci/lint-changed-sources.mjs", base],
    });
  }
  if (files.some((file) => frontend.test(file))) {
    for (const [id, script, flag] of [
      ["no-vanilla-extract", "verify-no-vanilla-extract.mjs", "--check"],
      [
        "ui-facade-boundary",
        "verify-ui-framework-dependency-graph.mjs",
        "--final-check",
      ],
      ["admin-ui-boundary", "verify-admin-ui-dependency-graph.mjs", "--check"],
    ])
      checks.push({
        id,
        command: "node",
        args: [`build/scripts/ci/${script}`, flag],
      });
  }
  if (files.some((file) => testSource.test(file))) {
    checks.push({
      id: "test-quality",
      command: "node",
      args: [
        "build/scripts/ci/audit-test-quality.mjs",
        "--ratchet",
        "--check-budgets",
        "--base",
        base,
      ],
    });
  }
  return checks;
}
