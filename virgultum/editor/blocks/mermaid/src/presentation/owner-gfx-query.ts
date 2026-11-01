// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Query } from "@virgultum/store";

import type { MermaidGfxProjection } from "./gfx-projection-owner.js";

export function createMermaidOwnerGfxQuery(
  projection: Pick<
    MermaidGfxProjection,
    "childElementIds" | "kind" | "ownerId" | "surfaceId"
  >,
): Query {
  return {
    mode: "include",
    match: [
      {
        flavour: "myoxus:surface",
        id: projection.surfaceId,
        viewType: "display",
      },
      {
        flavour:
          projection.kind === "direct" ? "myoxus:mermaid" : "myoxus:frame",
        id: projection.ownerId,
        viewType: "hidden",
      },
      ...projection.childElementIds.map((id) => ({
        id,
        viewType: "display" as const,
      })),
    ],
  };
}
