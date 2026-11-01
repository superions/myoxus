// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { prChecks } from "./ci-lane-plan.mjs";

const base = process.argv[2];
if (!base || !/^[a-f0-9]{40,64}$/.test(base))
  throw new Error("A verified base commit SHA is required");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const files = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"],
  { cwd: root, encoding: "utf8", timeout: 5_000 },
)
  .split("\0")
  .filter(Boolean);
const checks = prChecks(files, base);
for (const file of files) {
  if (/^(?:client|server|virgultum)\/(?:.*\/)?readme(?:[.-]|$)/i.test(file))
    throw new Error(`${file}: source-tree README is forbidden`);
  if (!/\.(?:json|mjs|cjs|js|sh)$/.test(file)) continue;
  if (lstatSync(resolve(root, file)).isSymbolicLink()) continue;
  if (file.endsWith(".json")) {
    JSON.parse(readFileSync(resolve(root, file), "utf8"));
  } else if (/\.(?:mjs|cjs|js)$/.test(file)) {
    checks.push({
      id: `syntax:${file}`,
      command: "node",
      args: ["--check", file],
    });
  } else if (file.endsWith(".sh")) {
    checks.push({ id: `syntax:${file}`, command: "bash", args: ["-n", file] });
  }
}
for (const check of checks) {
  console.log(`==> ${check.id}`);
  execFileSync(check.command, check.args, {
    cwd: root,
    stdio: "inherit",
    timeout: 55_000,
  });
}
console.log(
  `PR source checks passed for ${files.length} changed files. No build, dependency install or product test was run.`,
);
