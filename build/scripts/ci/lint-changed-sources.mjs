// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runWithProcessTreeTimeout } from "../test/process-tree-runner.mjs";
import { sourceToolPath, verifySourceTools } from "./source-tools.mjs";

const base = process.argv[2] ?? process.env.MYOXUS_INTEGRATION_BASE;
if (!base)
  throw new Error("MYOXUS_INTEGRATION_BASE must identify the integration diff");
const files = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"],
  { encoding: "utf8", timeout: 5_000 },
)
  .split("\0")
  .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file));
if (files.length) {
  const started = Date.now();
  const runtime = process.env.MYOXUS_CI_SOURCE_TOOLS;
  const temporaryConfig = resolve(`.myoxus-ci-oxlint-${process.pid}.json`);
  try {
    let command = "yarn";
    let args = ["exec", "oxlint", "--", ...files];
    if (runtime) {
      verifySourceTools();
      const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));
      // Preserve every repository rule. Only plugin resolution changes because
      // this checkout intentionally has no workspace dependency installation.
      for (const plugin of config.jsPlugins ?? []) {
        if (plugin.specifier !== "eslint-plugin-react-hooks")
          throw new Error("Unprovisioned CI Oxlint JS plugin");
        plugin.specifier = sourceToolPath(plugin.specifier);
      }
      writeFileSync(temporaryConfig, JSON.stringify(config));
      command = resolve(runtime, "node_modules/.bin/oxlint");
      args = ["--config", temporaryConfig, "--threads", "4", "--", ...files];
    }
    if (runtime && process.env.MYOXUS_CI_SOURCE_GROUP === "1") {
      // The PR bootstrap owns this group. A detached nested group could survive
      // its emergency KILL, so Oxlint must inherit the existing group in CI.
      execFileSync(command, args, {
        stdio: "inherit",
        timeout: 45_000,
        killSignal: "SIGKILL",
      });
    } else {
      const result = await runWithProcessTreeTimeout(command, args, {
        stdio: "inherit",
        timeoutMs: runtime ? 45_000 : 110_000,
        killGraceMs: 500,
      });
      if (result.status !== 0 || result.timedOut)
        process.exitCode = result.status ?? 1;
    }
  } finally {
    rmSync(temporaryConfig, { force: true });
    console.log(
      `Changed-source Oxlint: ${files.length} files, ${Date.now() - started} ms`,
    );
  }
} else console.log("No changed JavaScript/TypeScript sources to lint.");
