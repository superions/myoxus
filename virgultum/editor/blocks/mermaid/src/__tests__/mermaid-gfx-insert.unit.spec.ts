import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import { resolveMermaidGfxPendingNodeInsert } from "../mermaid-gfx-insert.js";

describe("Mermaid GFX pending node insert", () => {
  test("converts model points into frame-relative node insert coordinates", () => {
    expect(
      resolveMermaidGfxPendingNodeInsert({
        ownerXywh: new Bound(100, 200, 640, 480).serialize(),
        modelPoint: { x: 260, y: 344 },
        pendingShape: "diamond",
      }),
    ).toEqual({
      centerX: 160,
      centerY: 144,
      shape: "diamond",
    });
  });

  test("does not create an insert command payload without a pending shape", () => {
    expect(
      resolveMermaidGfxPendingNodeInsert({
        ownerXywh: new Bound(100, 200, 640, 480).serialize(),
        modelPoint: { x: 260, y: 344 },
        pendingShape: null,
      }),
    ).toBeNull();
  });
});
