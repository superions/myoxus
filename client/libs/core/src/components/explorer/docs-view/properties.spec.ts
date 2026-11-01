// @vitest-environment happy-dom

import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import { describe, expect, test } from "vitest";

import { getExplorerPropertyDocListPlacement } from "./property-placement";

describe("Explorer doc-list property placement", () => {
  test("skips unknown workspace property types instead of crashing the document list", () => {
    const property: { workspaceProperty: DocCustomPropertyInfo } = {
      workspaceProperty: {
        id: "prop-unknown",
        name: "Old local property",
        type: "unknown-local-type" as DocCustomPropertyInfo["type"],
      },
    };

    expect(getExplorerPropertyDocListPlacement(property)).toBeUndefined();
  });

  test("preserves known workspace property placement", () => {
    const property: { workspaceProperty: DocCustomPropertyInfo } = {
      workspaceProperty: {
        id: "prop-text",
        name: "Summary",
        type: "text" as DocCustomPropertyInfo["type"],
      },
    };

    expect(getExplorerPropertyDocListPlacement(property)).toBe("stack");
  });
});
