// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import { mermaidMindmapFamily } from "./family.js";
import { mindmapGfxHooks } from "./runtime-hooks.js";
import {
  mermaidMindmapHostAdapter,
  mindmapEdgelessToolbar,
} from "./host-adapter.js";
import { readMindmapProjectionOptions } from "./gfx-data.js";
import { readMindmapProjectionModel } from "./source-application.js";
import { projectMindmapTree } from "./projection/tree.js";
import { mermaidMindmapRendererToken } from "./react-host-contract.js";
import { mindmapPageSelectionTools } from "./actions.js";
import { mindmapDiagramTitle } from "./diagram-title.js";
/** Page, embedded and native consumers share this Source-owned runtime. */
export const mermaidMindmapRuntime = defineMermaidFamilyRuntime({
  ...mermaidMindmapFamily,
  preserveSourceBytes: true,
  rendererToken: mermaidMindmapRendererToken,
  gfxHooks: mindmapGfxHooks,
  diagramTitle: mindmapDiagramTitle,
  hostAdapter: mermaidMindmapHostAdapter,
  edgelessToolbar: mindmapEdgelessToolbar,
  pageSelectionTools: mindmapPageSelectionTools,
  applyGfxVisualToSource: (source, visual) => {
    const model = readMindmapProjectionModel(source, visual);
    return {
      source,
      diagnostics: [],
      visualModel: model
        ? projectMindmapTree(model, readMindmapProjectionOptions(visual))
        : visual,
    };
  },
  parseSourceToGfxVisualModel: (source) => {
    const model = readMindmapProjectionModel(source);
    return model ? projectMindmapTree(model) : null;
  },
  sourceDiagnostics: (source) =>
    mermaidMindmapFamily.parseSource(source, "mindmap").diagnostics,
  renderSurface: () => "core-facade" as const,
});
