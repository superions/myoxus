// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "./gfx-model.js";
import { getMermaidGfxFamilyHooksForDiagramType } from "./gfx-family-hooks-registry.js";
import type { MermaidVisualFamilyData } from "./gfx-family-data.js";

type LegacyReader = (key: string) => unknown;

export function mermaidLegacyProjectionFingerprint(
  diagramType: MermaidVisualModel["diagramType"],
  read: LegacyReader,
) {
  return (
    getMermaidGfxFamilyHooksForDiagramType(
      diagramType,
    )?.legacyProjectionFingerprint?.(read) ?? ""
  );
}

export function migrateLegacyMermaidNodeFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  current: MermaidVisualFamilyData | undefined,
  read: LegacyReader,
): MermaidVisualFamilyData | undefined {
  if (current) return current;
  return getMermaidGfxFamilyHooksForDiagramType(
    diagramType,
  )?.readLegacyNodeFamilyData?.(diagramType, read);
}

export function migrateLegacyMermaidEdgeFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  current: MermaidVisualFamilyData | undefined,
  read: LegacyReader,
): MermaidVisualFamilyData | undefined {
  if (current) return current;
  return getMermaidGfxFamilyHooksForDiagramType(
    diagramType,
  )?.readLegacyEdgeFamilyData?.(diagramType, read);
}

export function migrateLegacyMermaidSubgraphFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  current: MermaidVisualFamilyData | undefined,
  read: LegacyReader,
): MermaidVisualFamilyData | undefined {
  if (current) return current;
  return getMermaidGfxFamilyHooksForDiagramType(
    diagramType,
  )?.readLegacySubgraphFamilyData?.(diagramType, read);
}

export function migrateLegacyMermaidModelFamilyData(
  model: MermaidVisualModel,
): MermaidVisualFamilyData | undefined {
  if (model.familyData) return model.familyData;
  return getMermaidGfxFamilyHooksForDiagramType(
    model.diagramType,
  )?.readLegacyModelFamilyData?.(model);
}
