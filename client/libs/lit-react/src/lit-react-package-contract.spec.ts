// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../..");
const readRepoFile = (path: string) =>
  readFileSync(join(repoRoot, path), "utf8");

const retiredComponentLitNames = [
  "createReactComponentFromLit",
  "useLitPortalFactory",
  "uniReactRoot",
  "toReactNode",
  "ReactToLit",
  "ElementOrFactory",
] as const;

function componentRootImports(source: string) {
  return source
    .split(/;\s*\n/)
    .filter((statement) => /from\s+["']@myoxus\/component["']/.test(statement));
}

describe("lit-react package ownership", () => {
  test("component no longer exposes the Lit/React bridge", () => {
    expect(existsSync(join(repoRoot, "client/libs/component"))).toBe(false);
  });

  test("core imports bridge helpers from the neutral package", () => {
    const graphConsumers = [
      "client/libs/core/src/editor/virgultum/doc-editor/lit-adaper.tsx",
      "client/libs/core/src/editor/virgultum/doc-editor/bi-directional-link-panel.tsx",
      "client/libs/core/src/editor/database-block/properties/file/view.tsx",
      "client/libs/core/src/editor/ai/components/text-renderer.ts",
      "client/libs/core/src/editor/view-extensions/editor-view/notification-service.tsx",
      "client/libs/core/src/desktop/pages/workspace/layouts/workspace-layout.tsx",
    ];

    for (const file of graphConsumers) {
      const source = readRepoFile(file);
      expect(source, file).toContain("@myoxus/lit-react");
      for (const componentImport of componentRootImports(source)) {
        for (const helper of retiredComponentLitNames) {
          expect(componentImport, `${file} imports ${helper}`).not.toContain(
            helper,
          );
        }
      }
    }
  });
});
