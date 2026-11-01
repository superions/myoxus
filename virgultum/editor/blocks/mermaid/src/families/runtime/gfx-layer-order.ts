// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualModel } from "./gfx-model.js";
import { getMermaidVisualNodeDetailElementEntries } from "./gfx-element-projection.js";
import { getMermaidGfxFamilyHooks } from "./gfx-family-hooks-registry.js";

/** Persisted owners and transient candidates paint the same semantic layers. */
export function createMermaidElementIndexMaps(
  visualModel: MermaidVisualModel,
  nextIndex: () => string,
) {
  const hooks = getMermaidGfxFamilyHooks(visualModel);
  const background = visualModel.nodes.filter(
    (n) => hooks?.nodePaintLayer?.(visualModel, n) === "background",
  );
  const content = visualModel.nodes.filter((n) => !background.includes(n));
  const subgraphs = new Map(
    (visualModel.subgraphs ?? []).map((g) => [g.id, nextIndex()]),
  );
  const backgroundShapes = background.map((n) => [n.id, nextIndex()] as const);
  return {
    subgraphs,
    connectors: new Map(
      visualModel.edges.map((edge) => [edge.id, nextIndex()]),
    ),
    shapes: new Map([
      ...backgroundShapes,
      ...content.map((node) => [node.id, nextIndex()] as const),
    ]),
    details: new Map(
      getMermaidVisualNodeDetailElementEntries(visualModel).map(
        ({ elementId }) => [elementId, nextIndex()],
      ),
    ),
  };
}
