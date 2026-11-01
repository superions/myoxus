// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function repoPathExists(path: string): boolean {
  return existsSync(join(repoRoot, path));
}

describe("mobile navigation facade migration contract", () => {
  test("keeps tree, section and add-item chrome on shared navigation facade roles", () => {
    const treeNode = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/tree/node.tsx",
    );
    const treeRoot = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/tree/root.tsx",
    );
    const addItem = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/layouts/add-item-placeholder.tsx",
    );
    const section = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/layouts/collapsible-section.tsx",
    );

    for (const source of [treeNode, treeRoot, addItem, section]) {
      expect(source).toContain("@myoxus/ui-facade");
      expect(source).not.toMatch(/\.styles["']/);
      expect(source).not.toMatch(/\.css["']/);
      expect(source).not.toMatch(/\b[0-9]+px\b/);
    }

    expect(treeNode).toContain("StructureTreeRow");
    expect(treeNode).toContain('data-touch="true"');
    expect(treeNode).toContain("StructureTreeNodeRoot");
    expect(treeNode).toContain("StructureTreeLink");
    expect(treeNode).toContain("level={level}");
    expect(treeNode).toContain("StructureTreeCollapseButton");
    expect(treeNode).not.toContain("STRUCTURE_TREE_CLASS_NAMES");
    expect(treeNode).not.toContain("StructureTreeChildPlaceholder");
    expect(treeNode).not.toContain("structureTreeIndentStyle");
    expect(treeNode).not.toContain("style={");
    expect(treeNode).not.toContain("level * 20");
    expect(treeNode).not.toContain("fontSize={24}");

    expect(treeRoot).toContain("StructureTreeRoot");
    expect(treeRoot).not.toContain("StructureTreeRootPlaceholder");
    expect(addItem).toContain('data-placeholder="true"');
    expect(addItem).toContain("level={level}");
    expect(addItem).not.toContain("structureTreeIndentStyle");
    expect(addItem).not.toContain("style={");
    expect(section).toContain("SidebarSectionHeader");
    expect(section).toContain("SidebarSectionContent");
    expect(section).toContain("Collapse");
    expect(section).not.toContain("StructureTreeSectionContent");
    const retiredPrefix = ["Collaps", "ible"].join("");
    expect(section).not.toContain([retiredPrefix, "Content"].join(""));
  });

  test("keeps residual tag, doc loading and collection prompt chrome on existing facade primitives", () => {
    const tagNode = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/nodes/tag/index.tsx",
    );
    const tagDialog = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/nodes/tag/dialog.tsx",
    );
    const docNode = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/nodes/doc/index.tsx",
    );
    const collections = readRepoFile(
      "client/libs/core/src/mobile/components/navigation/sections/collections/index.tsx",
    );

    for (const [label, source] of [
      ["tagNode", tagNode],
      ["tagDialog", tagDialog],
      ["docNode", docNode],
    ] as const) {
      expect(source, label).toContain("@myoxus/ui-facade");
    }

    for (const [label, source] of [
      ["tagNode", tagNode],
      ["tagDialog", tagDialog],
      ["docNode", docNode],
      ["collections", collections],
    ] as const) {
      expect(source, label).not.toMatch(/\.styles["']/);
      expect(source, label).not.toContain("styles.");
      expect(source, label).not.toMatch(/\b[0-9]+px\b/);
      expect(source, label).not.toMatch(/style=\{\{/);
    }

    expect(tagNode).toContain("StructureTreeColorIcon");
    expect(tagDialog).toContain("Collapse");
    expect(tagDialog).not.toContain(["Collaps", "ible"].join(""));
    expect(tagDialog).toContain("ColorSwatch");
    expect(tagDialog).toContain("Group");
    expect(tagDialog).toContain("IconButton");
    expect(docNode).toContain("StructureTreeLoading");
    expect(collections).toContain("CollapsibleSection");
    expect(collections).toContain("StructureTreeRoot");
    expect(collections).toContain("AddItemPlaceholder");
  });

  test("does not restore retired mobile navigation style modules", () => {
    const retiredPaths = [
      "client/libs/core/src/mobile/components/navigation/tree/node.css",
      "client/libs/core/src/mobile/components/navigation/tree/node.styles.ts",
      "client/libs/core/src/mobile/components/navigation/tree/root.css",
      "client/libs/core/src/mobile/components/navigation/tree/root.styles.ts",
      "client/libs/core/src/mobile/components/navigation/layouts/add-item-placeholder.css",
      "client/libs/core/src/mobile/components/navigation/layouts/add-item-placeholder.styles.ts",
      "client/libs/core/src/mobile/components/navigation/layouts/collapsible-section.css",
      "client/libs/core/src/mobile/components/navigation/layouts/collapsible-section.styles.ts",
      "client/libs/core/src/mobile/components/navigation/nodes/doc/styles.css",
      "client/libs/core/src/mobile/components/navigation/nodes/doc/styles.styles.ts",
      "client/libs/core/src/mobile/components/navigation/nodes/tag/dialog.css",
      "client/libs/core/src/mobile/components/navigation/nodes/tag/dialog.styles.ts",
      "client/libs/core/src/mobile/components/navigation/nodes/tag/styles.css",
      "client/libs/core/src/mobile/components/navigation/nodes/tag/styles.styles.ts",
      "client/libs/core/src/mobile/components/navigation/sections/collections/index.css",
      "client/libs/core/src/mobile/components/navigation/sections/collections/index.styles.ts",
    ];

    for (const path of retiredPaths) {
      expect(repoPathExists(path), path).toBe(false);
    }
  });
});
