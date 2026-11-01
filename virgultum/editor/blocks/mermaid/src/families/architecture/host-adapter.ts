// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidFamilyHostAdapter,
  MermaidGfxRuntimeProjection,
} from "../runtime/contracts.js";
import {
  architectureEditorCapabilities,
  architecturePreviewEditorCapabilities,
  type ArchitectureCapabilityResolution,
} from "./editor-capabilities.js";
function isArchitectureCapabilityResolution(
  resolution: MermaidGfxRuntimeProjection,
): resolution is ArchitectureCapabilityResolution {
  return resolution.diagramType === "architecture";
}

export const mermaidArchitectureHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => {
    if (!isArchitectureCapabilityResolution(resolution)) {
      throw new Error(
        "Architecture host adapter requires a resolved Architecture GFX runtime.",
      );
    }
    return architectureEditorCapabilities(resolution);
  },
  projectPreview: architecturePreviewEditorCapabilities,
};
