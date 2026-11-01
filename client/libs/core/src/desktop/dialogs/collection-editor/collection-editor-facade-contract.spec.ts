// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const editorRoot = "client/libs/core/src/desktop/dialogs/collection-editor";

function repoFile(path: string) {
  return join(repoRoot, path);
}

function read(path: string) {
  return readFileSync(repoFile(path), "utf8");
}

describe("Collection editor facade migration contract", () => {
  test("keeps the removed collection-editor CSS island deleted", () => {
    for (const removedFile of [
      `${editorRoot}/edit-collection.css`,
      `${editorRoot}/edit-collection.styles.ts`,
    ]) {
      expect(existsSync(repoFile(removedFile)), removedFile).toBe(false);
    }
  });

  test("routes collection editor chrome through shared facade primitives", () => {
    const editCollection = read(`${editorRoot}/edit-collection.tsx`);
    const rulesMode = read(`${editorRoot}/rules-mode.tsx`);
    const combined = `${editCollection}\n${rulesMode}`;

    for (const facadeRole of [
      "Accordion",
      "AccordionControl",
      "AccordionItem",
      "AccordionPanel",
      "DialogFooter",
      "DialogFooterActions",
      "EmptyState",
      "BadgeList",
      "BadgeListItem",
      "Flex",
      "Group",
      "MyoxusText",
      "RemovableBadge",
      "Scrollable",
      "Stack",
      "SurfaceListHeader",
      "SurfaceListHeaderTitle",
      "SurfaceListItemIcon",
      "SurfaceListText",
      "Tabs",
      "TabsContent",
      "TabsList",
      "TabsTrigger",
    ]) {
      expect(combined, facadeRole).toContain(facadeRole);
    }
    expect(combined).not.toContain("SurfaceListPropertyPill");

    expect(combined).toContain('data-myoxus-ui-role="collection-editor"');
    expect(combined).toContain('data-myoxus-ui-role="collection-rules-mode"');
    expect(rulesMode).toContain("showPreview ? (");
    expect(rulesMode).toContain(
      'variant={showPreview ? "primary" : "secondary"}',
    );
    expect(rulesMode).toContain("strikethrough={Boolean(trash)}");
    expect(combined).not.toContain("MyoxusSegmentedControl");
    expect(combined).not.toContain("Masonry");
    expect(combined).not.toContain("ToggleDownIcon");
    expect(combined).not.toContain("ToggleRightIcon");
  });

  test("does not reintroduce route-local style systems", () => {
    const combined = [
      `${editorRoot}/edit-collection.tsx`,
      `${editorRoot}/rules-mode.tsx`,
    ]
      .map(read)
      .join("\n");

    for (const forbidden of [
      "./edit-collection.styles",
      "classNames(",
      "className=",
      "style={{",
      "iconStyle=",
      "matchMedia",
      "RadioGroup",
      "rotate(",
      "useMediaQuery",
      "var(--myoxus-",
      "window.innerWidth",
    ]) {
      expect(combined, forbidden).not.toContain(forbidden);
    }

    expect(combined).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
    expect(combined).not.toMatch(/@media|breakpoint/i);
  });
});
