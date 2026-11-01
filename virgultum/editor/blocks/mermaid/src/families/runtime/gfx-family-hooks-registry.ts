// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "./gfx-model.js";
import { getMermaidFamilyRuntimes } from "./registry.js";

export function getMermaidGfxFamilyHooks(model: MermaidVisualModel | null) {
  if (!model) return null;
  return (
    getMermaidFamilyRuntimes().find((runtime) => runtime.gfxHooks?.owns(model))
      ?.gfxHooks?.hooks ?? null
  );
}

export function getMermaidGfxFamilyHooksForDiagramType(diagramType: string) {
  return (
    getMermaidFamilyRuntimes().find((runtime) =>
      runtime.gfxHooks?.ownsDiagramType(diagramType),
    )?.gfxHooks?.hooks ?? null
  );
}
