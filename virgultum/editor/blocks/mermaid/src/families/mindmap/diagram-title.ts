// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeMermaidDiagramTitle } from "../../engine/diagram-title.js";
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";

/** Mindmap has no body title. The shared title boundary owns YAML patches and
 * the block-title projection, including the existing embedded Note scope. */
export const mindmapDiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: () => [],
  resolve: () => null,
  patch: (source, _diagramType, title) =>
    writeMermaidDiagramTitle({ source, diagramType: "mindmap", title }),
};
