// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { describe, expect, test } from "vitest";

import { sortWorkspaceNavigationItems } from "./workspace-menu";

const base = join(
  process.cwd(),
  "client/libs/core/src/components/root-app-sidebar",
);
const read = (file: string) => readFileSync(join(base, file), "utf8");

describe("Workspace navigation", () => {
  test("sorts personal workspaces before shared workspaces", () => {
    const workspaces: WorkspaceMetadata[] = [
      {
        id: "shared-beta",
        name: "Beta",
        flavour: "myoxus-cloud",
        workspaceType: "Shared",
      },
      {
        id: "personal",
        name: "Myoxus Admin",
        flavour: "myoxus-cloud",
        workspaceType: "Personal",
      },
      {
        id: "shared-alpha",
        name: "Alpha",
        flavour: "myoxus-cloud",
        workspaceType: "Shared",
      },
    ];

    expect(
      sortWorkspaceNavigationItems(workspaces).map((workspace) => workspace.id),
    ).toEqual(["personal", "shared-alpha", "shared-beta"]);
  });

  test("keeps navigation grouped by responsibility", () => {
    const composition = read("index.tsx");

    expect(composition).toContain("<SidebarNavPinned>");
    expect(composition).toContain("<PrimaryNavigation />");
    expect(composition).toContain("<SidebarNavList>");
    expect(composition).toContain("<WorkspaceViewsNavigation />");
    expect(composition).toContain("<LibrarySection />");
    expect(composition).toContain(
      '<StructureTreeOrganizeTree chrome="folders" />',
    );
    expect(composition).toContain("<SidebarNavSectionDivider />");
    expect(composition).toContain("<TrashButton />");
    expect(composition).toContain("<UserInfo />");
    expect(composition.indexOf("<SidebarNavPinned>")).toBeLessThan(
      composition.indexOf("<SidebarNavList>"),
    );
    expect(composition.indexOf("<SidebarNavList>")).toBeLessThan(
      composition.indexOf("<SidebarNavFooter>"),
    );
    expect(composition.indexOf("<TrashButton />")).toBeLessThan(
      composition.indexOf("<UserInfo />"),
    );
  });

  test("keeps primary routes direct and Library contextual", () => {
    const primary = read("primary-navigation.tsx");
    const library = read("library-section.tsx");

    expect(primary).toContain("<AddPageButton />");
    expect(primary).toContain("<AllPagesLink />");
    expect(primary).toContain("export function WorkspaceViewsNavigation");
    expect(primary).toContain("<JournalLink />");
    expect(primary).toContain("<DiagramsLink />");
    expect(primary).not.toContain("GraphButton");
    expect(library).toContain("<CollectionsLink");
    expect(library).not.toContain("nestedChildren");
    expect(library).not.toContain("useCreateCollection");
    expect(library).not.toContain("create-collection-sidebar-button");
    expect(library).toContain("com.myoxus.rootAppSidebar.library");
  });
});
