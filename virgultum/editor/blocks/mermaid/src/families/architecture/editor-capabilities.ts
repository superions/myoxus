// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidEditorCapabilities,
  MermaidGfxFamilyProjection,
} from "../runtime/editor-capabilities.js";
import type { MermaidGfxRuntimeProjection } from "../runtime/contracts.js";
import { createArchitectureEditorProps } from "./interaction-controller.js";
import { mermaidArchitecturePageSelectionTools } from "./page-selection-tools.js";
import { mermaidArchitectureRendererToken } from "./react-host-contract.js";
import { architecturePageActionContribution } from "./page-actions.js";

export type ArchitectureCapabilityResolution = MermaidGfxRuntimeProjection & {
  readonly diagramType: "architecture";
};

export function architectureEditorCapabilities(
  resolution: ArchitectureCapabilityResolution,
): MermaidEditorCapabilities {
  return {
    kind: "gfx",
    project: (projection, displayOnly) =>
      projection.renderGfx(resolution.visualModel, {
        displayOnly,
        // Architecture owns the same React action surfaces in Page and in an
        // opened Edgeless Note. Opt the embedded consumer into the existing
        // local Facade slot; the contribution itself already suppresses the
        // Page action row there and renders only contextual embedded actions.
        embeddedFacadeSurface: true,
        pageSelectionTools: mermaidArchitecturePageSelectionTools,
        renderSurface: resolution.renderSurface,
        projectActions: (context) => {
          const props = createArchitectureEditorProps(
            context,
            resolution.source,
          );
          const body = context.reactHost?.renderFamilyEditor(
            mermaidArchitectureRendererToken,
            props,
          );
          return body
            ? ({
                actions: architecturePageActionContribution(props, context),
                body,
              } satisfies MermaidGfxFamilyProjection)
            : null;
        },
      }),
    renderSurface: resolution.renderSurface,
    pageSelectionTools: mermaidArchitecturePageSelectionTools,
  };
}

export function architecturePreviewEditorCapabilities(
  visualModel: MermaidGfxRuntimeProjection["visualModel"],
  source: string,
) {
  return architectureEditorCapabilities({
    diagramType: "architecture",
    renderSurface: "core-facade",
    source,
    visualModel,
  });
}
