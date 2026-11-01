#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

const domains = JSON.parse(
  readFileSync(
    new URL("../../test-matrix/api-integration-domains.json", import.meta.url),
    "utf8",
  ),
);
const suite = process.argv[2];
if (!Object.hasOwn(domains, suite))
  throw new Error(`Unknown API integration domain: ${suite}`);
const prefixes = domains[suite].map(({ module }) => {
  if (!/^\w+$/.test(module)) throw new Error(`Invalid module: ${module}`);
  return `${module}::`;
});
if (!prefixes.length) throw new Error(`Empty integration domain: ${suite}`);
if (process.argv[3] === "--select-tests") {
  // Select exact libtest names, including nested tests, so similarly named
  // modules cannot leak into a different capability's execution.
  const available = readFileSync(0, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.endsWith(": test"))
    .map((line) => line.slice(0, -6));
  for (const prefix of prefixes) {
    if (!available.some((name) => name.startsWith(prefix))) {
      throw new Error(
        `Integration domain ${suite} selects no tests for ${prefix}`,
      );
    }
  }
  process.stdout.write(
    available
      .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
      .join("\n") + "\n",
  );
} else {
  process.stdout.write(prefixes.join("\n") + "\n");
}
