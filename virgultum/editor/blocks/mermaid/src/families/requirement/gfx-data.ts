// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualEndpointPosition,
} from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";
import type { RequirementPropertyName } from "../../engine/requirement/index.js";

const REQUIREMENT_FAMILY = "requirement";

export type MermaidRequirementNodeGfxData = {
  readonly sourceKey?: string;
  /** Providers belong only to the effective definition, in Source order. */
  readonly propertyKeys?: Partial<Record<RequirementPropertyName, string[]>>;
  readonly styles?: Readonly<Record<string, string>>;
} & (
  | {
      readonly family: typeof REQUIREMENT_FAMILY;
      readonly kind: "element";
      readonly docRef: string;
      readonly elementType: string;
    }
  | {
      readonly family: typeof REQUIREMENT_FAMILY;
      readonly kind: "requirement";
      readonly requirementId: string;
      readonly requirementType: string;
      readonly risk: string;
      readonly text: string;
      readonly verifyMethod: string;
    }
);

export type MermaidRequirementEdgeGfxData = {
  readonly family: typeof REQUIREMENT_FAMILY;
  readonly sourceKey?: string;
  readonly relationKind: string;
  /** Derived layout ports can follow Direction without overwriting a manual port. */
  readonly layoutSourcePosition?: MermaidVisualEndpointPosition;
  readonly layoutTargetPosition?: MermaidVisualEndpointPosition;
};

export function requirementNodeGfxData(
  node: Pick<MermaidVisualNode, "familyData">,
): MermaidRequirementNodeGfxData | undefined {
  const data = mermaidVisualFamilyPayload(node.familyData, REQUIREMENT_FAMILY);
  if (!data) return undefined;
  if (data.kind === "element") {
    return {
      sourceKey:
        typeof data.sourceKey === "string" ? data.sourceKey : undefined,
      propertyKeys:
        data.propertyKeys as MermaidRequirementNodeGfxData["propertyKeys"],
      styles: data.styles as MermaidRequirementNodeGfxData["styles"],
      docRef: typeof data.docRef === "string" ? data.docRef : "",
      elementType: typeof data.elementType === "string" ? data.elementType : "",
      family: REQUIREMENT_FAMILY,
      kind: "element",
    };
  }
  if (data.kind !== "requirement") return undefined;
  return {
    sourceKey: typeof data.sourceKey === "string" ? data.sourceKey : undefined,
    propertyKeys:
      data.propertyKeys as MermaidRequirementNodeGfxData["propertyKeys"],
    styles: data.styles as MermaidRequirementNodeGfxData["styles"],
    family: REQUIREMENT_FAMILY,
    kind: "requirement",
    requirementId:
      typeof data.requirementId === "string" ? data.requirementId : "",
    requirementType:
      typeof data.requirementType === "string"
        ? data.requirementType
        : "requirement",
    risk: typeof data.risk === "string" ? data.risk : "",
    text: typeof data.text === "string" ? data.text : "",
    verifyMethod:
      typeof data.verifyMethod === "string" ? data.verifyMethod : "",
  };
}

export function requirementEdgeGfxData(
  edge: Pick<MermaidVisualEdge, "familyData">,
): MermaidRequirementEdgeGfxData | undefined {
  const data = mermaidVisualFamilyPayload(edge.familyData, REQUIREMENT_FAMILY);
  if (!data) return undefined;
  return {
    sourceKey: typeof data.sourceKey === "string" ? data.sourceKey : undefined,
    family: REQUIREMENT_FAMILY,
    relationKind:
      typeof data.relationKind === "string" && data.relationKind
        ? data.relationKind
        : "satisfies",
    layoutSourcePosition: readLayoutPosition(data.layoutSourcePosition),
    layoutTargetPosition: readLayoutPosition(data.layoutTargetPosition),
  };
}

function readLayoutPosition(
  value: unknown,
): MermaidVisualEndpointPosition | undefined {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
    ? [value[0], value[1]]
    : undefined;
}

export function requirementNodeFamilyData(
  data:
    | Omit<
        Extract<MermaidRequirementNodeGfxData, { kind: "element" }>,
        "family"
      >
    | Omit<
        Extract<MermaidRequirementNodeGfxData, { kind: "requirement" }>,
        "family"
      >,
): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(REQUIREMENT_FAMILY, data);
}

export function requirementEdgeFamilyData(
  data: Omit<MermaidRequirementEdgeGfxData, "family">,
): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(REQUIREMENT_FAMILY, data);
}

export function setMermaidVisualEdgeRequirementRelationKind(
  model: MermaidVisualModel,
  edgeId: string,
  kind: string,
): MermaidVisualModel {
  return {
    ...model,
    edges: model.edges.map((edge) =>
      edge.id === edgeId
        ? {
            ...edge,
            familyData: requirementEdgeFamilyData({
              sourceKey: requirementEdgeGfxData(edge)?.sourceKey,
              relationKind: kind.trim() || "satisfies",
            }),
          }
        : edge,
    ),
  };
}
