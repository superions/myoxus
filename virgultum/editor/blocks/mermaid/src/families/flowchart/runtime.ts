import { mermaidFlowchartFamily } from "./family.js";
import { mermaidFlowchartHostAdapter } from "./host-adapter.js";
import { mermaidFlowchartGfxHookRegistration } from "./runtime-hooks.js";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import { applyFlowchartGfxVisualToSource } from "./source-application.js";
import { createFlowchartEdgelessToolbarConfig } from "./edgeless-toolbar.js";
import { mermaidFlowchartDiagramTitle } from "./diagram-title.js";
import { mermaidFlowchartPageSelectionTools } from "./page-selection-tools.js";

export const mermaidFlowchartRuntime = defineMermaidFamilyRuntime({
  ...mermaidFlowchartFamily,
  diagramTitle: mermaidFlowchartDiagramTitle,
  hostAdapter: mermaidFlowchartHostAdapter,
  pageSelectionTools: mermaidFlowchartPageSelectionTools,
  gfxHooks: mermaidFlowchartGfxHookRegistration,
  edgelessToolbar: createFlowchartEdgelessToolbarConfig(
    mermaidFlowchartGfxHookRegistration,
  ),
  applyGfxVisualToSource: (previousSource, visualModel) => ({
    diagnostics: [],
    source: applyFlowchartGfxVisualToSource(previousSource, visualModel),
  }),
  parseSourceToGfxVisualModel: (source, diagramType) => {
    const state = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(source, diagramType),
    );
    return state.kind === "editable" ? state.visualModel : null;
  },
  renderSurface: () => "core-facade" as const,
  sourceDiagnostics: (source, diagramType) =>
    mermaidFlowchartFamily.parseSource(source, diagramType).diagnostics,
});
