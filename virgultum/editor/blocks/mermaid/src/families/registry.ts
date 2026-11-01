import type { MermaidDiagramType } from "../engine/diagram-types.js";
import {
  isMermaidProductDiagramType,
  type MermaidProductDiagramType,
  type MermaidProductFamilyId,
} from "../engine/product-types.js";
import { getMermaidFamilyRuntime } from "./runtime/registry.js";

export type MermaidFamilyDiagramCapability = {
  readonly diagramType: MermaidDiagramType;
  readonly familyId: MermaidProductFamilyId | null;
  readonly reason: string | null;
  readonly visualEditing: boolean;
};

export function getMermaidFamilyDiagramCapability(
  diagramType: MermaidDiagramType,
): MermaidFamilyDiagramCapability {
  const family = isMermaidProductDiagramType(diagramType)
    ? getMermaidFamilyRuntime(diagramType)
    : null;
  if (!family || !isMermaidProductDiagramType(diagramType)) {
    return {
      diagramType,
      familyId: null,
      reason:
        "Diagram type is not part of the Mermaid product family registry.",
      visualEditing: false,
    };
  }

  const visualEditing = family.renderSurface(diagramType) !== "source-first";
  return {
    diagramType,
    familyId: family.id,
    reason: visualEditing
      ? null
      : "Diagram type is parser-supported but has no approved visual editor path.",
    visualEditing,
  };
}

export function isMermaidFamilyVisualEditingDiagramType(
  diagramType: MermaidDiagramType,
): diagramType is MermaidProductDiagramType {
  return getMermaidFamilyDiagramCapability(diagramType).visualEditing;
}
