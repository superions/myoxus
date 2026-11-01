// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const SRC_ROOT = resolve(__dirname, "../../../..");
const INSTANTIATION_FILE = resolve(
  __dirname,
  "../services/template-instantiation.ts",
);

const FORBIDDEN_NAMES = [
  "BUILTIN_JOURNAL_TEMPLATES",
  "BUILTIN_ONBOARDING_TEMPLATES",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__"]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
};

describe("native-only document delivery", () => {
  test("active product code has no content builder collections or registry", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      if (
        FORBIDDEN_NAMES.some((name) => text.includes(name)) ||
        text.includes("builtin-builder-registry")
      )
        offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
  test("product code cannot bypass TemplateInstantiationService", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file === INSTANTIATION_FILE) continue;
      const text = readFileSync(file, "utf-8");
      if (
        text.includes(".applyTemplate(") ||
        text.includes("duplicateFromTemplate")
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
