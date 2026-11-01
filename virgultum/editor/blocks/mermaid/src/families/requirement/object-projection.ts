// SPDX-License-Identifier: AGPL-3.0-or-later

import { requirementNodeGfxData } from "./gfx-data.js";
import type { RequirementPropertyName } from "../../engine/requirement/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";

export function projectRequirementMaterializedNode(
  node: MermaidVisualNode,
  _type: MermaidVisualModel["diagramType"],
): MermaidVisualNode {
  const data = requirementNodeGfxData(node);
  return {
    ...node,
    displayLabel: node.label,
    textAlign: "left",
    textVerticalAlign: "top",
    details: createRequirementDetails({
      ownerId: node.id,
      sourceKey: data?.sourceKey,
      propertyKeys: data?.propertyKeys,
      requirementDocRef: data?.kind === "element" ? data.docRef : undefined,
      requirementElementType:
        data?.kind === "element" ? data.elementType : undefined,
      requirementId:
        data?.kind === "requirement" ? data.requirementId : undefined,
      requirementType:
        data?.kind === "requirement" ? data.requirementType : undefined,
      requirementText: data?.kind === "requirement" ? data.text : undefined,
      requirementRisk: data?.kind === "requirement" ? data.risk : undefined,
      requirementVerifyMethod:
        data?.kind === "requirement" ? data.verifyMethod : undefined,
    }),
  };
}

import type { MermaidVisualNodeDetail } from "../runtime/gfx-model.js";

type RequirementDetailInput = {
  ownerId: string;
  sourceKey?: string;
  propertyKeys?: Partial<Record<RequirementPropertyName, string[]>>;
  requirementDocRef?: string;
  requirementElementType?: string;
  requirementId?: string;
  requirementRisk?: string;
  requirementText?: string;
  requirementType?: string;
  requirementVerifyMethod?: string;
};

function detailId(...parts: readonly string[]) {
  return parts
    .join("-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function propertyDetail(
  ownerId: string,
  sourceKey: string,
  label: string,
  value: string | undefined,
  order: number,
  providerKey?: string,
  present = value !== undefined && value !== "",
): MermaidVisualNodeDetail | null {
  return present
    ? {
        id: detailId("requirement-property", ownerId, sourceKey),
        kind: "requirement-property",
        label,
        order,
        sourceKey: providerKey,
        value,
      }
    : null;
}

export function createRequirementDetails({
  ownerId,
  sourceKey,
  propertyKeys,
  requirementDocRef,
  requirementElementType,
  requirementId,
  requirementRisk,
  requirementText,
  requirementType,
  requirementVerifyMethod,
}: RequirementDetailInput): MermaidVisualNodeDetail[] {
  const property = (
    name: RequirementPropertyName,
    label: string,
    value: string | undefined,
    order: number,
  ) =>
    propertyDetail(
      ownerId,
      name,
      label,
      value,
      order,
      propertyKeys?.[name]?.[0],
      propertyKeys
        ? Boolean(propertyKeys[name]?.length)
        : value !== undefined && value !== "",
    );
  const stereotype: MermaidVisualNodeDetail = {
    id: detailId("requirement-kind", ownerId),
    kind: "requirement-property",
    label: `«${requirementType ?? "element"}»`,
    order: 0,
    sourceKey: requirementType ? sourceKey : undefined,
  };
  const details = requirementType
    ? [
        stereotype,
        property("id", "id", requirementId, 1),
        property("risk", "risk", requirementRisk, 2),
        property("verifymethod", "verify", requirementVerifyMethod, 3),
        property("text", "text", requirementText, 4),
      ]
    : [
        stereotype,
        property("type", "type", requirementElementType, 1),
        property("docref", "docref", requirementDocRef, 2),
      ];
  details.push({
    id: detailId("requirement-divider", ownerId),
    kind: "separator",
    label: "",
    order: 0.5,
  });
  return details.filter(
    (detail): detail is MermaidVisualNodeDetail => detail !== null,
  );
}
