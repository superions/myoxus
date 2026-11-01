// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defineMermaidFamilyRuntime,
  resolveEditableMermaidFamilyModel,
} from "../runtime/factory.js";
import { createMermaidGfxEdgelessToolbarConfig } from "../runtime/gfx-edgeless-toolbar.js";
import { mermaidRequirementFamily } from "./family.js";
import {
  mermaidRequirementHostAdapter,
  requirementEdgelessToolbar,
} from "./host-adapter.js";
import { requirementGfxHooks } from "./runtime-hooks.js";
import { requirementModelToGfxVisualModel } from "./visual-model.js";
import { applyRequirementGfxVisualToSource } from "./source-application.js";
import { requirementPageSelectionTools } from "./actions.js";
import { requirementDiagramTitle } from "./diagram-title.js";

export const mermaidRequirementRuntime = defineMermaidFamilyRuntime({
  ...mermaidRequirementFamily,
  preserveSourceBytes: true,
  diagramTitle: requirementDiagramTitle,
  pageSelectionTools: requirementPageSelectionTools,
  hostAdapter: mermaidRequirementHostAdapter,
  gfxHooks: requirementGfxHooks,
  edgelessToolbar: {
    ...createMermaidGfxEdgelessToolbarConfig(requirementGfxHooks),
    actions: [
      ...requirementEdgelessToolbar.actions,
      ...createMermaidGfxEdgelessToolbarConfig(
        requirementGfxHooks,
      ).actions.filter(
        (action) =>
          ![
            "e.delete",
            "mermaid-family.add-node",
            "mermaid-family.connect",
          ].includes(action.id),
      ),
    ],
  },
  applyGfxVisualToSource: (source, visual) => ({
    diagnostics: [],
    ...applyRequirementGfxVisualToSource(source, visual),
  }),
  parseSourceToGfxVisualModel: (source, type) => {
    const model = resolveEditableMermaidFamilyModel(
      mermaidRequirementFamily,
      source,
      type,
    );
    return model ? requirementModelToGfxVisualModel(model) : null;
  },
  sourceDiagnostics: (source, type) =>
    mermaidRequirementFamily.parseSource(source, type).diagnostics,
  renderSurface: () => "core-facade" as const,
});
