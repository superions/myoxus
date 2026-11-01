// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("all pages list action menu contract", () => {
  test("the row action trigger opens its popover without navigating the surrounding row link", () => {
    const listItemSource = readRepoFile(
      "client/libs/core/src/components/explorer/docs-view/doc-list-item.tsx",
    );
    const menuSource = readRepoFile(
      "client/libs/core/src/components/explorer/docs-view/more-menu.tsx",
    );

    expect(listItemSource).toContain("<MoreMenuButton");
    expect(menuSource).toContain("event.preventDefault();");
    expect(menuSource).toContain("event.stopPropagation();");
    expect(menuSource).toContain("iconOnClick?.(event);");
    expect(menuSource).toContain("onClick={handleTriggerClick}");
    expect(menuSource).toContain("{...safeIconProps}");
  });

  test("the document information action lives in the row overflow menu", () => {
    const menuSource = readRepoFile(
      "client/libs/core/src/components/explorer/docs-view/more-menu.tsx",
    );
    const listItemSource = readRepoFile(
      "client/libs/core/src/components/explorer/docs-view/doc-list-item.tsx",
    );

    expect(menuSource).toContain("const DocInfo");
    expect(menuSource).toContain('workspaceDialogService.open("doc-info"');
    expect(menuSource).toContain("track.allDocs.list.docMenu.openDocInfo()");
    expect(menuSource).toContain("prefixIcon={<InformationIcon />}");
    expect(menuSource).toContain('data-testid="doc-list-operation-info"');
    expect(menuSource).toContain("<DocInfo {...props} />");
    expect(listItemSource).not.toContain("<DocInfo");
  });
});
