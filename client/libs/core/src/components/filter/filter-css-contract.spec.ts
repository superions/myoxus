// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const filterRoot = "client/libs/core/src/components/filter";
const allDocsRoot = "client/libs/core/src/desktop/pages/workspace/all-page";
const allDocsModuleRoot = "client/libs/core/src/modules/all-docs";

function repoFile(path: string) {
  return join(repoRoot, path);
}

function read(path: string) {
  return readFileSync(repoFile(path), "utf8");
}

describe("Core filter facade migration contract", () => {
  test("keeps the filter builder free of route-local CSS modules", () => {
    for (const removedFile of [
      `${filterRoot}/styles.css`,
      `${filterRoot}/styles.styles.ts`,
      `${filterRoot}/conditions/styles.css`,
      `${filterRoot}/conditions/styles.styles.ts`,
    ]) {
      expect(existsSync(repoFile(removedFile))).toBe(false);
    }

    for (const sourceFile of [
      `${filterRoot}/add-filter.tsx`,
      `${filterRoot}/filter.tsx`,
      `${filterRoot}/filters.tsx`,
      `${filterRoot}/conditions/condition.tsx`,
      `${filterRoot}/conditions/unknown.tsx`,
      `${filterRoot}/filter-value-menu.tsx`,
    ]) {
      const source = read(sourceFile);

      expect(source).not.toContain("styles.styles");
      expect(source).not.toContain("className={styles");
      expect(source).not.toContain("filterItemStyle");
      expect(source).not.toContain("filterTypeStyle");
      expect(source).not.toContain("filterValueStyle");
      expect(source).not.toContain("switchStyle");
      expect(source).not.toContain('size="16"');
    }
  });

  test("routes filter chrome through shared facade roles", () => {
    const addFilter = read(`${filterRoot}/add-filter.tsx`);
    const filter = read(`${filterRoot}/filter.tsx`);
    const filters = read(`${filterRoot}/filters.tsx`);
    const condition = read(`${filterRoot}/conditions/condition.tsx`);
    const filterValueMenu = read(`${filterRoot}/filter-value-menu.tsx`);

    expect(filters).toContain("FilterBar");
    expect(filter).toContain("FilterChip");
    expect(filter).toContain("IconButton");
    expect(filter).not.toMatch(/<div[^>]+onClick=\{onDelete\}/);
    expect(addFilter).toContain("MenuDetailRow");
    expect(addFilter).toContain("MenuInlineText");
    expect(addFilter).toContain('panelWidth: "default"');
    expect(addFilter).toContain(
      'data-myoxus-ui-role="filter-menu-favorite-option"',
    );
    expect(condition).toContain("FilterChipSegment");
    expect(condition).toContain("FilterChipTrigger");
    expect(condition).toContain("FilterChipValueSlot");
    expect(filterValueMenu).toContain("FilterChipTrigger");
    expect(filterValueMenu).not.toContain("alignOffset");
  });

  test("keeps all-docs filter creation separate from saved-filter shortcuts", () => {
    const allPage = read(`${allDocsRoot}/all-page.tsx`);
    const savedFilters = read(`${allDocsRoot}/saved-filters.tsx`);
    const allDocsModule = read(`${allDocsModuleRoot}/index.ts`);

    expect(allPage).toContain("AllDocsSavedFiltersService");
    expect(allPage).toContain("createSavedFilter");
    expect(allPage).toContain("updateSavedFilter");
    expect(allPage).toContain('kind: "savedFilter"');
    expect(allPage).not.toContain("createCollection");
    expect(allPage).not.toContain("updateCollection");
    expect(allPage).not.toContain("addPinnedCollection");
    expect(allPage).not.toContain("editCollectionName");
    expect(allPage).not.toContain("editCollection.saveCollection");
    expect(savedFilters).toContain("<AddFilterMenu");
    expect(savedFilters).toMatch(/<AddFilterMenu\s+includeAllPagesOnly/);
    expect(savedFilters).toContain("closeOnItemClick: false");
    expect(savedFilters).toContain("onOpenChange: setOpen");
    expect(savedFilters).toContain(
      'data-myoxus-ui-role="all-docs-filter-trigger"',
    );
    expect(savedFilters).toContain("AllDocsSavedFilter");
    expect(savedFilters).not.toContain("CollectionService");
    expect(savedFilters).not.toContain("PinnedCollectionService");
    expect(savedFilters).not.toContain("WorkspaceDialogService");
    expect(savedFilters).not.toContain("collection-editor");
    expect(savedFilters).not.toContain("add-saved-filter-trigger");
    expect(savedFilters).not.toContain("saved-filter-menu-option");
    expect(savedFilters).not.toContain("setAddingFilter(true)");
    expect(savedFilters).not.toContain(
      "rootAppSidebar.explorer.collection-section-add-tooltip",
    );
    expect(savedFilters).not.toContain(
      'data-myoxus-ui-role="add-pinned-collection-filter-action"',
    );
    expect(allDocsModule).toContain("WorkspaceScope");
    expect(allDocsModule).toContain(".scope(WorkspaceScope)");
    expect(allDocsModule).toContain(
      ".service(AllDocsSavedFiltersService, [WorkspaceLocalState])",
    );
  });

  test("keeps the all-docs saved-filter bar on shared facade filter chrome", () => {
    for (const removedFile of [
      `${allDocsRoot}/pinned-collections.css`,
      `${allDocsRoot}/pinned-collections.styles.ts`,
    ]) {
      expect(existsSync(repoFile(removedFile))).toBe(false);
    }

    const savedFilters = read(`${allDocsRoot}/saved-filters.tsx`);

    expect(existsSync(repoFile(`${allDocsRoot}/pinned-collections.tsx`))).toBe(
      false,
    );
    expect(savedFilters).not.toContain("pinned-collections.styles");
    expect(savedFilters).not.toContain("className={styles");
    expect(savedFilters).not.toContain('role="button"');
    expect(savedFilters).not.toContain('size="16"');
    expect(savedFilters).toContain("FilterBar");
    expect(savedFilters).toContain("FilterChip");
    expect(savedFilters).toContain("FilterChipTrigger");
    expect(savedFilters).toContain('data-myoxus-ui-role="saved-filter-bar"');
    expect(savedFilters).not.toContain("wrap={false}");
    expect(savedFilters).toContain("<FilterBarSpacer />");
  });
});
