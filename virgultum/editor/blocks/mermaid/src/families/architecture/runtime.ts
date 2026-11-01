import { mermaidArchitectureFamily } from "./family.js";
import { mermaidArchitectureHostAdapter } from "./host-adapter.js";
import { mermaidArchitectureGfxHookRegistration } from "./runtime-hooks.js";
import { applyArchitectureGfxVisualToSource } from "./source-application.js";
import { architectureModelToGfxVisualModel } from "./visual-model.js";
import { mermaidArchitectureDiagramTitle } from "./diagram-title.js";
import {
  defineMermaidFamilyRuntime,
  resolveEditableMermaidFamilyModel,
} from "../runtime/factory.js";
import { architectureEdgelessToolbarConfig } from "../../edgeless-toolbar/architecture/toolbar.js";
import { mermaidArchitecturePageSelectionTools } from "./page-selection-tools.js";

export const mermaidArchitectureRuntime = defineMermaidFamilyRuntime({
  ...mermaidArchitectureFamily,
  diagramTitle: mermaidArchitectureDiagramTitle,
  edgelessToolbar: architectureEdgelessToolbarConfig,
  hostAdapter: mermaidArchitectureHostAdapter,
  gfxHooks: mermaidArchitectureGfxHookRegistration,
  pageSelectionTools: mermaidArchitecturePageSelectionTools,
  applyGfxVisualToSource: (previousSource, visualModel) => ({
    diagnostics: [],
    source: applyArchitectureGfxVisualToSource(previousSource, visualModel),
  }),
  parseSourceToGfxVisualModel: (source, diagramType) => {
    const model = resolveEditableMermaidFamilyModel(
      mermaidArchitectureFamily,
      source,
      diagramType,
    );
    return model ? architectureModelToGfxVisualModel(model) : null;
  },
  renderSurface: () => "core-facade" as const,
  sourceDiagnostics: (source, diagramType) =>
    mermaidArchitectureFamily.parseSource(source, diagramType).diagnostics,
});
