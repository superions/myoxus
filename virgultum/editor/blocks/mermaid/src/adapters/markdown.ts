// SPDX-License-Identifier: AGPL-3.0-or-later

import { MermaidBlockSchema } from "@virgultum/core/models";
import { nanoid } from "@virgultum/core/store";

import { parseMermaidSourceToGfxVisualModel } from "../mermaid-gfx-graph-adapters.js";
import { resolveMermaidBlockInsertIdentity } from "../mermaid-insert-identity.js";

// Keep synchronous snapshot consumers stable; store registration imports only
// the matcher, which loads this family-dependent work from its async enter hook.
export * from "./markdown-matcher.js";

export function createMermaidBlockSnapshot(source: string, title = "") {
  const identity = resolveMermaidBlockInsertIdentity({ source, title });
  const parsed = parseMermaidSourceToGfxVisualModel(identity.source);
  return {
    type: "block" as const,
    id: nanoid(),
    flavour: MermaidBlockSchema.model.flavour,
    props: {
      diagramType: parsed.diagramType,
      diagramVersion: 1,
      displayMode: "edit",
      renderEngine: null,
      renderHash: null,
      source: {
        "$virgultum:internal:text$": true,
        delta: [
          {
            insert: identity.source,
          },
        ],
      },
      sourceHash: parsed.sourceHash,
      viewportHeight: null,
      title: {
        "$virgultum:internal:text$": true,
        delta: identity.title
          ? [
              {
                insert: identity.title,
              },
            ]
          : [],
      },
    },
    children: [],
  };
}
