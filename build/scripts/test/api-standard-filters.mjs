#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

const groups = JSON.parse(
  readFileSync(
    new URL("../../test-matrix/api-standard-filters.json", import.meta.url),
    "utf8",
  ),
);
const group = process.argv[2] ?? "api";
if (group !== "all" && !Object.hasOwn(groups, group)) {
  throw new Error(`Unknown API standard group: ${group}`);
}
const filters = group === "all" ? Object.values(groups).flat() : groups[group];
if (
  !filters.length ||
  new Set(filters).size !== filters.length ||
  filters.some((filter) => !/^\w+::\w+$/.test(filter))
) {
  throw new Error(
    `Invalid or duplicate exact filters in API standard group: ${group}`,
  );
}
process.stdout.write(filters.join("\n") + "\n");
