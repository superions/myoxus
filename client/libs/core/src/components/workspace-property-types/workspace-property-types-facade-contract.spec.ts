// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

const migratedRoots = [
  "client/libs/core/src/components/workspace-property-types",
  "client/libs/core/src/components/properties/icons",
  "client/libs/core/src/components/properties/manager",
  "client/libs/core/src/components/properties/widgets",
];

const removedLocalFiles = [
  "client/libs/core/src/components/properties/icons/icons-selector.css",
  "client/libs/core/src/components/properties/icons/icons-selector.styles.ts",
  "client/libs/core/src/components/properties/manager/styles.css",
  "client/libs/core/src/components/properties/manager/styles.styles.ts",
  "client/libs/core/src/components/properties/widgets/radio-group.css",
  "client/libs/core/src/components/properties/widgets/radio-group.styles.ts",
  "client/libs/core/src/components/workspace-property-types/checkbox.css",
  "client/libs/core/src/components/workspace-property-types/checkbox.styles.ts",
  "client/libs/core/src/components/workspace-property-types/created-updated-at.css",
  "client/libs/core/src/components/workspace-property-types/created-updated-at.styles.ts",
  "client/libs/core/src/components/workspace-property-types/created-updated-by.css",
  "client/libs/core/src/components/workspace-property-types/created-updated-by.styles.ts",
  "client/libs/core/src/components/workspace-property-types/date.css",
  "client/libs/core/src/components/workspace-property-types/date.styles.ts",
  "client/libs/core/src/components/workspace-property-types/doc-primary-mode.css",
  "client/libs/core/src/components/workspace-property-types/doc-primary-mode.styles.ts",
  "client/libs/core/src/components/workspace-property-types/edgeless-theme.css",
  "client/libs/core/src/components/workspace-property-types/edgeless-theme.styles.ts",
  "client/libs/core/src/components/workspace-property-types/journal.css",
  "client/libs/core/src/components/workspace-property-types/journal.styles.ts",
  "client/libs/core/src/components/workspace-property-types/number.css",
  "client/libs/core/src/components/workspace-property-types/number.styles.ts",
  "client/libs/core/src/components/workspace-property-types/page-width.css",
  "client/libs/core/src/components/workspace-property-types/page-width.styles.ts",
  "client/libs/core/src/components/workspace-property-types/template.css",
  "client/libs/core/src/components/workspace-property-types/template.styles.ts",
  "client/libs/core/src/components/workspace-property-types/text.css",
  "client/libs/core/src/components/workspace-property-types/text.styles.ts",
  "client/libs/core/src/editor/database-block/properties/created-by/view.css",
  "client/libs/core/src/editor/database-block/properties/file/style.css",
  "client/libs/core/src/editor/database-block/properties/file/style.styles.ts",
  "client/libs/core/src/editor/database-block/properties/member/multi-member-select/style.css",
  "client/libs/core/src/editor/database-block/properties/member/multi-member-select/style.styles.ts",
  "client/libs/core/src/editor/database-block/properties/member/style.css",
  "client/libs/core/src/editor/database-block/properties/member/style.styles.ts",
  "client/libs/core/src/editor/database-block/components/loading.css",
  "client/libs/core/src/editor/database-block/components/loading.styles.ts",
  "client/libs/core/src/editor/database-block/components/loading.tsx",
];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function listSourceFiles(path: string): string[] {
  const absolute = join(repoRoot, path);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  return readdirSync(absolute).flatMap((entry) => {
    const child = join(absolute, entry);
    const rel = relative(repoRoot, child);
    if (statSync(child).isDirectory()) return listSourceFiles(rel);
    return /\.(?:ts|tsx)$/.test(entry) &&
      !/\.(?:spec|test)\.(?:ts|tsx)$/.test(entry)
      ? [rel]
      : [];
  });
}

describe("workspace property facade migration contract", () => {
  test("keeps migrated workspace-property CSS modules and dormant loader deleted", () => {
    for (const file of removedLocalFiles) {
      expect(
        statSync(join(repoRoot, file), { throwIfNoEntry: false }),
        file,
      ).toBe(undefined);
    }
  });

  test("keeps migrated property surfaces on existing facade primitives", () => {
    const manager = readRepoFile(
      "client/libs/core/src/components/properties/manager/index.tsx",
    );
    const iconSelector = readRepoFile(
      "client/libs/core/src/components/properties/icons/icons-selector.tsx",
    );
    const radioGroup = readRepoFile(
      "client/libs/core/src/components/properties/widgets/radio-group.tsx",
    );
    const text = readRepoFile(
      "client/libs/core/src/components/workspace-property-types/text.tsx",
    );

    expect(manager).toContain("PropertyRoot");
    expect(manager).toContain("PropertyName");
    expect(manager).toContain("PropertyValue");
    expect(manager).toContain('layout="compact-row"');
    expect(manager).toContain("SurfaceListItemIcon");
    expect(iconSelector).toContain("MenuOptionGroup");
    expect(iconSelector).toContain("MenuOptionButton");
    expect(iconSelector).toContain("MenuScrollableSection");
    expect(radioGroup).toContain("<RadioGroup");
    expect(radioGroup).toContain("block");
    expect(radioGroup).not.toContain("BUILD_CONFIG.isMobileEdition");
    expect(radioGroup).not.toContain("itemHeight");
    expect(radioGroup).not.toContain("borderRadius");
    expect(text).toContain("autosize");
    expect(text).toContain("preserveWhitespace");
  });

  test("blocks local CSS and hard geometry from the migrated property cluster", () => {
    const offenders: string[] = [];
    const sourceFiles = migratedRoots.flatMap(listSourceFiles);

    for (const file of sourceFiles) {
      const source = readRepoFile(file);
      if (
        /from\s+["'][^"']*\.styles["']/.test(source) ||
        /import\s+["'][^"']*\.css["']/.test(source) ||
        /\bstyles\./.test(source) ||
        /\b(?:sideOffset|alignOffset)\s*:/.test(source) ||
        /\bstyle=\{\{/.test(source) ||
        /\b\d+px\b/.test(source)
      ) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
