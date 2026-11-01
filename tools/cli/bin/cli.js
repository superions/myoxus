#!/usr/bin/env node
import { spawnSync } from "node:child_process";

spawnSync("yarn", ["r", "myoxus.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
});
