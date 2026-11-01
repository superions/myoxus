// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("document graph Workbench context ownership", () => {
  test("uses one selection-scoped central capability and no local details layout", () => {
    const view = read(
      "client/libs/core/src/modules/document-graph/view/document-graph-workspace-view.tsx",
    );
    const page = read(
      "client/libs/core/src/desktop/pages/workspace/all-page/all-page.tsx",
    );
    const header = read(
      "client/libs/core/src/desktop/pages/workspace/all-page/all-page-header.tsx",
    );

    expect(page).toContain('viewFamily="graph"');
    expect(view).toContain('surfaceId="graph-details"');
    expect(view).toContain("{graph && selection ? (");
    expect(view).toContain('view.showTool("graph-details")');
    expect(view).toContain('view.showDefaultTool("graph-details")');
    expect(view).toContain("if (!graph || !selection) return;");
    expect(view).toContain("if (!stillAvailable) setSelection(null)");
    expect(view).not.toContain("detailsVisible");
    expect(view).not.toContain("<Grid");
    expect(view).not.toContain("preferredSelection");
    expect(page).not.toContain("graphDetailsVisible");
    expect(header).not.toContain("document-graph-details-toggle");
  });
});
