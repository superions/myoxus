// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  requirementEdgeFamilyData,
  requirementNodeFamilyData,
} from "./gfx-data.js";
import type { MermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";

export type RequirementLegacyReader = (key: string) => unknown;

const LEGACY_KEYS = [
  "mermaidFlowchartVisualStyleVersion",
  "mermaidNodeRequirementDocRef",
  "mermaidNodeRequirementElementType",
  "mermaidNodeRequirementId",
  "mermaidNodeRequirementRisk",
  "mermaidNodeRequirementText",
  "mermaidNodeRequirementType",
  "mermaidNodeRequirementVerifyMethod",
  "mermaidEdgeRequirementRelationKind",
] as const;

const text = (value: unknown) => (typeof value === "string" ? value : null);

export function requirementLegacyProjectionFingerprint(
  read: RequirementLegacyReader,
) {
  return LEGACY_KEYS.map((key) => `${key}=${String(read(key) ?? "")}`).join(
    ",",
  );
}

export function readRequirementLegacyNodeFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  read: RequirementLegacyReader,
): MermaidVisualFamilyData | undefined {
  if (
    read("mermaidRole") !== "mermaid-flowchart-node" ||
    read("mermaidFlowchartVisualStyleVersion") !== "gfx-flowchart-v1"
  )
    return undefined;
  if (diagramType === "requirementDiagram") {
    const requirementType = text(read("mermaidNodeRequirementType"));
    const requirementId = text(read("mermaidNodeRequirementId"));
    const risk = text(read("mermaidNodeRequirementRisk"));
    const requirementText = text(read("mermaidNodeRequirementText"));
    const verifyMethod = text(read("mermaidNodeRequirementVerifyMethod"));
    if (requirementType) {
      if (
        requirementId === null ||
        risk === null ||
        requirementText === null ||
        verifyMethod === null
      )
        return undefined;
      return requirementNodeFamilyData({
        kind: "requirement",
        requirementId,
        requirementType,
        risk,
        text: requirementText,
        verifyMethod,
      });
    }
    const elementType = text(read("mermaidNodeRequirementElementType"));
    const docRef = text(read("mermaidNodeRequirementDocRef"));
    if (elementType === null || docRef === null) return undefined;
    if (elementType || docRef) {
      return requirementNodeFamilyData({
        docRef,
        elementType,
        kind: "element",
      });
    }
  }
  return undefined;
}

export function readRequirementLegacyEdgeFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  read: RequirementLegacyReader,
): MermaidVisualFamilyData | undefined {
  if (read("mermaidRole") !== "mermaid-flowchart-edge") return undefined;
  if (diagramType === "requirementDiagram") {
    const relationKind = text(read("mermaidEdgeRequirementRelationKind"));
    if (relationKind) return requirementEdgeFamilyData({ relationKind });
  }
  return undefined;
}

export function readRequirementLegacyModelFamilyData(
  model: MermaidVisualModel,
): MermaidVisualFamilyData | undefined {
  return model.familyData;
}
