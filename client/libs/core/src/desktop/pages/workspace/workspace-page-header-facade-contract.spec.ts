// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function listTsxFiles(path: string): string[] {
  return readdirSync(join(repoRoot, path), { withFileTypes: true }).flatMap(
    (entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return listTsxFiles(entryPath);
      return entry.name.endsWith(".tsx") ? [entryPath] : [];
    },
  );
}

describe("workspace page header facade contract", () => {
  test("the global route shell is the only Workbench header shell", () => {
    const frame = readRepoFile("client/libs/ui-facade/src/workbench-frame.tsx");
    const headerProviderPattern =
      /WorkbenchHeaderFrame|AllCollectionHeader|AllDocsHeader|AllTagHeader|DetailPageHeader|JournalWorkbenchHeader|TagCatalogPage|TemplateCatalogPage|TagDetailHeader|AttachmentWorkbenchHeader/;

    expect(frame).toContain('component="header"');
    expect(frame).toContain("data-myoxus-ui-role={`${uiRole}:divider`}");

    // The route receives its header from the catalog render prop. Keep that
    // provider covered instead of accepting its name without checking ownership.
    const templateCatalog = readRepoFile(
      "client/libs/core/src/modules/template-doc/view/catalog-page.tsx",
    );
    expect(templateCatalog).toContain("<WorkbenchHeaderFrame");
    expect(templateCatalog).toContain("header: <TemplateCatalogHeader />");

    const viewHeaderSources = [
      ...listTsxFiles("client/libs/core/src/desktop/pages/workspace"),
      ...listTsxFiles("client/libs/core/src/editor/attachment-viewer"),
    ]
      .map((path) => [path, readRepoFile(path)] as const)
      .filter(([, source]) => source.includes("<ViewHeader"));

    for (const [sourcePath, source] of viewHeaderSources) {
      expect(
        source,
        `${sourcePath} must provide the shared Workbench header frame or a canonical frame provider`,
      ).toMatch(headerProviderPattern);
      expect(
        source,
        `${sourcePath} must not restore a route-owned page-header shell`,
      ).not.toContain("WorkbenchPageHeader");
    }
  });

  test("does not restore the retired explorer word-tab header navigation", () => {
    for (const removedPath of [
      "client/libs/core/src/components/explorer/header/navigation.tsx",
      "client/libs/core/src/components/explorer/header/navigation.css",
      "client/libs/core/src/components/explorer/header/navigation.styles.ts",
      "client/libs/core/src/components/pure/workspace-mode-filter-tab/index.css",
      "client/libs/core/src/components/pure/workspace-mode-filter-tab/index.styles.ts",
      "client/libs/core/src/components/pure/workspace-mode-filter-tab/index.tsx",
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }
  });

  test("collection and tag-detail headers use the consolidated facade header pattern", () => {
    const sources = [
      [
        "client/libs/core/src/desktop/pages/workspace/all-collection/header.tsx",
        "WorkbenchHeaderTitle",
      ],
      [
        "client/libs/core/src/modules/tag/view/tag-detail-header.tsx",
        "WorkbenchHeaderContextPath",
      ],
    ].map(
      ([path, titleRole]) => [path, readRepoFile(path), titleRole] as const,
    );

    for (const removedPath of [
      "client/libs/core/src/desktop/pages/workspace/all-collection/header.css",
      "client/libs/core/src/desktop/pages/workspace/all-collection/header.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }

    for (const [sourcePath, source, titleRole] of sources) {
      expect(
        source,
        `${sourcePath} must not restore a route-owned page-header shell`,
      ).not.toContain("WorkbenchPageHeader");
      expect(source, `${sourcePath} must use WorkbenchHeaderFrame`).toContain(
        "WorkbenchHeaderFrame",
      );
      expect(
        source,
        `${sourcePath} must use its canonical header title role`,
      ).toContain(titleRole);
      expect(
        source,
        `${sourcePath} must not restore the old data-page header rail`,
      ).not.toContain("DataPageHeaderRail");
      expect(
        source,
        `${sourcePath} must not nest toolbar surfaces inside HeaderMenu`,
      ).not.toContain("HeaderActionBar");
      expect(
        source,
        `${sourcePath} must not restore explorer word-tab navigation`,
      ).not.toContain("ExplorerNavigation");
      expect(
        source,
        `${sourcePath} must not use the old standalone display menu trigger`,
      ).not.toContain("ExplorerDisplayMenuButton");
      expect(
        source,
        `${sourcePath} must not return to ad-hoc header menu sections`,
      ).not.toContain("WorkbenchHeaderMenuSection");
      expect(
        source,
        `${sourcePath} must collapse narrow create actions to icon-only chrome`,
      ).not.toContain('narrow={t["com.myoxus.editor.at-menu.new-doc"]()}');
      expect(source, `${sourcePath} must not use legacy Header`).not.toContain(
        "@myoxus/core/components/pure/header",
      );
      expect(
        source,
        `${sourcePath} must not import route styles`,
      ).not.toContain(".styles");
    }
  });

  test("desktop tag detail uses shared document and database usage", () => {
    const usageOwner = readRepoFile(
      "client/libs/core/src/modules/tag/view/tag-usage-list.tsx",
    );
    expect(usageOwner).toContain("tagList.databaseUsageState$(tagId)");
    expect(usageOwner).toContain("tagList.documentUsageState$(tagId)");
    expect(usageOwner).toContain("CollectionRulesService");
    const route = "client/libs/core/src/desktop/pages/workspace/tag/index.tsx";
    const source = readRepoFile(route);
    expect(source).toContain("@myoxus/core/modules/tag/view/tag-usage-list");
    expect(source).toContain("<TagUsageList");
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/desktop/pages/workspace/tag/usage-list.tsx",
        ),
      ),
    ).toBe(false);
  });

  test("utility route headers use the same consolidated facade header pattern", () => {
    const diagramsSource = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/diagrams/index.tsx",
    );
    const trashSource = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/trash-page.tsx",
    );
    const sources = [
      [
        "client/libs/core/src/desktop/pages/workspace/diagrams/index.tsx",
        diagramsSource,
      ],
      [
        "client/libs/core/src/desktop/pages/workspace/trash-page.tsx",
        trashSource,
      ],
    ] as const;

    for (const [sourcePath, source] of sources) {
      expect(
        source,
        `${sourcePath} must not restore a route-owned page-header shell`,
      ).not.toContain("WorkbenchPageHeader");
      expect(source, `${sourcePath} must use WorkbenchHeaderFrame`).toContain(
        "WorkbenchHeaderFrame",
      );
      expect(
        source,
        `${sourcePath} must use WorkbenchHeaderContextPath`,
      ).toContain("WorkbenchHeaderContextPath");
      expect(
        source,
        `${sourcePath} must not restore old card-title header chrome`,
      ).not.toContain("CardTitle");
      expect(
        source,
        `${sourcePath} must not restore old ad-hoc header groups`,
      ).not.toContain("HeaderActionGroup");
      expect(
        source,
        `${sourcePath} must not restore priority-slot action bars in headers`,
      ).not.toContain("HeaderActionPrioritySlot");
      expect(
        source,
        `${sourcePath} must not return to ad-hoc header menu sections`,
      ).not.toContain("WorkbenchHeaderMenuSection");
      expect(
        source,
        `${sourcePath} must not restore the old data-page header rail`,
      ).not.toContain("DataPageHeaderRail");
      expect(
        source,
        `${sourcePath} must not nest local header action bars`,
      ).not.toContain("HeaderActionBar");
    }

    expect(
      diagramsSource,
      "diagram creation belongs in the visible catalog instead of header menu nesting",
    ).not.toContain("HeaderMenuButton");
    expect(diagramsSource).toContain("RadioCardGroup");

    expect(
      trashSource,
      "trash keeps its single destructive bulk action visible instead of hiding it in a secondary menu",
    ).toContain('data-myoxus-ui-role="trash-empty-button"');
    expect(
      trashSource,
      "trash must not restore old ad-hoc menus",
    ).not.toContain("MenuPanel");
    expect(trashSource).not.toContain("HeaderMenuButton");
  });

  test("keeps route actions visible and tool menus under the shared Workbench owner", () => {
    const menuFreeHeaders = [
      "client/libs/core/src/desktop/pages/workspace/all-collection/header.tsx",
      "client/libs/core/src/desktop/pages/workspace/diagrams/index.tsx",
      "client/libs/core/src/modules/tag/view/tag-detail-header.tsx",
      "client/libs/core/src/desktop/pages/workspace/trash-page.tsx",
    ];
    for (const sourcePath of menuFreeHeaders) {
      expect(readRepoFile(sourcePath), sourcePath).not.toContain(
        "HeaderMenuButton",
      );
    }

    const journal = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/journals/journal-workbench-header.tsx",
    );
    expect(journal).toContain("WorkbenchToolsHeaderMenuButton");
    expect(journal).not.toContain("<Menu");
    expect(journal).not.toContain("MenuItem");
    const chat = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/chat/index.tsx",
    );
    expect(chat).toContain("<WorkbenchToolsHeaderMenuButton");
    expect(chat).not.toMatch(/<HeaderMenuButton\b|<MenuItem\b/);
  });

  test("collection and tag body/list chrome no longer depends on local route CSS", () => {
    const sourcePaths = [
      "client/libs/core/src/desktop/pages/workspace/all-collection/index.tsx",
      "client/libs/core/src/desktop/pages/workspace/tag/index.tsx",
    ];
    const sources = sourcePaths.map(
      (path) => [path, readRepoFile(path)] as const,
    );

    for (const removedPath of [
      "client/libs/core/src/desktop/pages/workspace/all-collection/index.css",
      "client/libs/core/src/desktop/pages/workspace/all-collection/index.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/all-tag/all-tag.css",
      "client/libs/core/src/desktop/pages/workspace/all-tag/all-tag.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/all-tag/header.tsx",
      "client/libs/core/src/desktop/pages/workspace/all-tag/index.tsx",
      "client/libs/core/src/desktop/pages/workspace/collection/index.tsx",
      "client/libs/core/src/desktop/pages/workspace/collection/index.css",
      "client/libs/core/src/desktop/pages/workspace/collection/index.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/collection/collection.css",
      "client/libs/core/src/desktop/pages/workspace/collection/collection.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/tag/index.css",
      "client/libs/core/src/desktop/pages/workspace/tag/index.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }

    for (const [sourcePath, source] of sources) {
      expect(
        source,
        `${sourcePath} must not import route styles`,
      ).not.toContain(".styles");
      expect(source, `${sourcePath} must not use styles.*`).not.toContain(
        "styles.",
      );
    }

    for (const sourcePath of sourcePaths.filter((path) =>
      path.endsWith("index.tsx"),
    )) {
      const source = readRepoFile(sourcePath);
      expect(source, `${sourcePath} must use PageContentRail`).toContain(
        "PageContentRail",
      );
      expect(
        source,
        `${sourcePath} must compose its body with a Facade rail`,
      ).toContain("PageContentRail");
    }

    const allCollectionPage = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/all-collection/index.tsx",
    );
    expect(
      allCollectionPage,
      "All Collections must keep the empty-state create action out of the body when the Workbench header already owns it",
    ).toContain("showAction={false}");
    expect(
      allCollectionPage,
      "All Collections must not restore the old list-header create-action prop",
    ).not.toContain("showCreateAction");

    const pageListEmpty = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/page-list-empty.tsx",
    );
    expect(
      pageListEmpty,
      "EmptyCollectionList must allow routes to suppress its generic CTA instead of duplicating header actions",
    ).toContain("showAction = true");
    expect(pageListEmpty).toContain("{ action: null }");

    const workbenchRouter = readRepoFile(
      "client/libs/core/src/desktop/workbench-router.ts",
    );
    const workbenchEntity = readRepoFile(
      "client/libs/core/src/modules/workbench/entities/workbench.ts",
    );
    const rootSidebar = readRepoFile(
      "client/libs/core/src/components/root-app-sidebar/index.tsx",
    );
    expect(workbenchRouter).not.toContain('path: "/collection/:collectionId"');
    expect(workbenchRouter).not.toContain(
      'import("./pages/workspace/collection/index")',
    );
    expect(workbenchEntity).toContain(
      "new URLSearchParams({ collection: collectionId })",
    );
    expect(workbenchEntity).toContain(
      "this.open(`/all?${search.toString()}`, options)",
    );
    expect(workbenchEntity).not.toContain(
      "this.open(`/collection/${collectionId}`, options)",
    );
    expect(rootSidebar).not.toContain("routeCollectionId");
    expect(rootSidebar).not.toContain('startsWith("/collection/")');

    for (const sourcePath of [
      "client/libs/core/src/components/page-list/page-group.tsx",
      "client/libs/core/src/components/structure-tree/nodes/collection/index.tsx",
      "client/libs/core/src/modules/app-tabs-header/services/app-tabs-header-service.ts",
      "client/libs/core/src/modules/workbench/view/split-view/types.ts",
    ]) {
      expect(
        readRepoFile(sourcePath),
        `${sourcePath} must navigate collection detail through canonical All Docs state`,
      ).not.toContain("/collection/${");
    }
  });

  test("all docs body composes facade rails instead of route-local body CSS", () => {
    const sourcePath =
      "client/libs/core/src/desktop/pages/workspace/all-page/all-page.tsx";
    const source = readRepoFile(sourcePath);

    for (const removedPath of [
      "client/libs/core/src/desktop/pages/workspace/all-page/all-page.css",
      "client/libs/core/src/desktop/pages/workspace/all-page/all-page.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/all-page/migration-data.css",
      "client/libs/core/src/desktop/pages/workspace/all-page/migration-data.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/all-page/dark-migration.png",
      "client/libs/core/src/desktop/pages/workspace/all-page/light-migration.png",
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }

    for (const required of [
      "Stack",
      "Box",
      "PageContentRail",
      "ToolbarSurface",
      "FilterBar",
      'data-myoxus-ui-role="all-docs-body-stack"',
      'data-myoxus-ui-role="all-docs-filter-editor-surface"',
      'data-myoxus-ui-role="all-docs-filter-actions"',
      'data-myoxus-ui-role="all-docs-docs-viewport"',
    ]) {
      expect(source, `${sourcePath} must use ${required}`).toContain(required);
    }
    expect(
      source,
      `${sourcePath} must not add route-local container queries`,
    ).not.toContain("containerType=");

    for (const forbidden of [
      "./all-page.styles",
      "className={styles.",
      "styles.",
      "style={{",
      "@mantine/",
    ]) {
      expect(
        source,
        `${sourcePath} must not contain ${forbidden}`,
      ).not.toContain(forbidden);
    }
    expect(source, `${sourcePath} must not contain px literals`).not.toMatch(
      /\b\d+px\b/,
    );

    expect(source).not.toContain("MigrationAllDocsDataNotification");
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/desktop/pages/workspace/all-page/migration-data.tsx",
        ),
      ),
    ).toBe(false);
  });

  test("workspace list empty states use the shared EmptyState facade without local wrappers", () => {
    const sourcePath =
      "client/libs/core/src/desktop/pages/workspace/page-list-empty.tsx";
    const source = readRepoFile(sourcePath);

    for (const removedPath of [
      "client/libs/core/src/desktop/pages/workspace/page-list-empty.css",
      "client/libs/core/src/desktop/pages/workspace/page-list-empty.styles.ts",
      "client/libs/core/src/editor/virgultum/page-list/index.css",
      "client/libs/core/src/editor/virgultum/page-list/index.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }

    for (const required of [
      "Stack",
      "EmptyDocs",
      "EmptyCollections",
      'data-myoxus-ui-role="page-list-empty"',
    ]) {
      expect(source, `${sourcePath} must use ${required}`).toContain(required);
    }
    for (const forbidden of [
      "./page-list-empty.styles",
      "className={styles",
      "styles.",
      "style={{",
      "emptyDescButton",
      "plusButton",
      "descWrapper",
      "0px",
      "8px",
    ]) {
      expect(
        source,
        `${sourcePath} must not contain ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });
});
