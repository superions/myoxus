// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  defineMermaidFamilyRuntime,
  resolveEditableMermaidFamilyModel,
} from "../runtime/factory.js";
import { mermaidC4HostAdapter } from "./host-adapter.js";
import { mermaidC4Family, isC4DiagramType } from "./family.js";
import { c4DiagramTitle } from "./diagram-title.js";
import { c4ModelToGfxVisualModel } from "./visual-model.js";
import { applyC4GfxVisualToSource } from "./source-application.js";
import { layoutC4Diagram } from "./layout.js";
import { mermaidC4RendererToken } from "./react-host-contract.js";
import { C4_COMMANDS } from "./actions.js";
import { c4PageSelectionTools } from "./selection-tools.js";
import { c4EdgelessToolbar } from "./edgeless-toolbar.js";

import { c4GfxHooks } from "./gfx-hooks.js";
export { c4GfxHooks } from "./gfx-hooks.js";

export const mermaidC4Runtime = defineMermaidFamilyRuntime({
  ...mermaidC4Family,
  preserveSourceBytes: true,
  rendererToken: mermaidC4RendererToken,
  semanticCommands: C4_COMMANDS,
  pageSelectionTools: c4PageSelectionTools,
  diagramTitle: c4DiagramTitle,
  gfxHooks: c4GfxHooks,
  hostAdapter: mermaidC4HostAdapter,
  edgelessToolbar: c4EdgelessToolbar,
  applyGfxVisualToSource: (source, visual) => ({
    diagnostics: [],
    ...applyC4GfxVisualToSource(source, visual),
  }),
  parseSourceToGfxVisualModel: (source, type) => {
    if (!isC4DiagramType(type)) return null;
    const model = resolveEditableMermaidFamilyModel(
      mermaidC4Family,
      source,
      type,
    );
    return model
      ? c4ModelToGfxVisualModel({
          ...model,
          ...layoutC4Diagram(model),
        })
      : null;
  },
  sourceDiagnostics: (source) =>
    mermaidC4Family.parseSource(source, "c4").diagnostics,
  renderSurface: () => "core-facade" as const,
});
