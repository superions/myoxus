#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
const history = JSON.parse(
  readFileSync(
    new URL("./archived-release-reservations.json", import.meta.url),
    "utf8",
  ),
);
const [scope, version] = process.argv.slice(2);
if (!["containers", "clients"].includes(scope) || !version)
  throw new Error("Expected containers|clients and a version");
const owners = scope === "clients" ? ["clients"] : ["server", "frontends"];
if (owners.some((owner) => Object.hasOwn(history.components[owner], version))) {
  console.error(
    "Version belongs to the archived source. Verify original artifacts or choose a new version; never rebuild archived releases from Myoxus history.",
  );
  process.exitCode = 1;
}
