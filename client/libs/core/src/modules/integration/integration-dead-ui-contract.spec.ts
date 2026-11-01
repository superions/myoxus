// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const integrationRoot = "client/libs/core/src/modules/integration";
const deletedUiPaths = [
  "views/properties-table.tsx",
  "views/property-values/date-value.tsx",
  "views/property-values/index.tsx",
  "views/property-values/link-value.tsx",
  "views/property-values/source-value.tsx",
  "views/property-values/styles.css",
  "views/property-values/styles.styles.ts",
  "views/property-values/text-value.tsx",
  "views/property-values/type.ts",
].map((path) => `${integrationRoot}/${path}`);
const sourceExtensions = new Set([".ts", ".tsx"]);

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function collectSourceFiles(dir: string): string[] {
  const absoluteDir = join(repoRoot, dir);
  if (!existsSync(absoluteDir)) return [];

  return readdirSync(absoluteDir).flatMap((entry) => {
    const absoluteEntry = join(absoluteDir, entry);
    const relativeEntry = relative(repoRoot, absoluteEntry);
    const stats = statSync(absoluteEntry);

    if (stats.isDirectory()) {
      return collectSourceFiles(relativeEntry);
    }

    if (![...sourceExtensions].some((ext) => relativeEntry.endsWith(ext))) {
      return [];
    }

    if (relativeEntry.endsWith(".spec.ts")) {
      return [];
    }

    return [relativeEntry];
  });
}

describe("integration module dead UI contract", () => {
  test("keeps the unmounted document property table removed", () => {
    for (const path of deletedUiPaths) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }

    const publicModule = readRepoFile(`${integrationRoot}/index.ts`);
    expect(publicModule).toContain(
      'export { IntegrationTypeIcon } from "./views/icon";',
    );
    expect(publicModule).not.toContain("DocIntegrationPropertiesTable");
    expect(publicModule).not.toContain("./views/properties-table");
  });

  test("does not retain source imports to the removed property value renderer", () => {
    for (const path of collectSourceFiles("client/libs/core/src")) {
      const source = readRepoFile(path);
      expect(source, path).not.toContain("DocIntegrationPropertiesTable");
      expect(source, path).not.toContain("views/property-values");
      expect(source, path).not.toContain("./property-values");
    }
  });
});
