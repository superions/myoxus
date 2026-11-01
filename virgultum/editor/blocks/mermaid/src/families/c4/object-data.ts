// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonObject,
  type MermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";

import {
  c4BoundaryPresentation,
  type C4BoundaryPresentation,
} from "./gfx-data.js";

const C4_FAMILY = "c4";

type MermaidC4GfxDetails = {
  readonly description: string;
  readonly link: string;
  readonly sprite: string;
  readonly tags: string;
};

export type MermaidC4BoundaryGfxData = MermaidC4GfxDetails &
  C4BoundaryPresentation & {
    readonly sourceParentId: string;
    readonly boundaryKind: string;
    readonly boundaryType: string;
    readonly effectiveSprite: string;
    readonly family: typeof C4_FAMILY;
    readonly label: string;
    readonly spriteOverridden: boolean;
  };

export type MermaidC4NodeGfxData = MermaidC4GfxDetails & {
  readonly effectiveSprite: string;
  readonly effectiveTechnology: string;
  readonly family: typeof C4_FAMILY;
  readonly kind: string;
  readonly sourceTechnology: string;
  readonly spriteOverridden: boolean;
};

export type MermaidC4EdgeGfxData = MermaidC4GfxDetails & {
  readonly family: typeof C4_FAMILY;
  readonly index: string | null;
  readonly dynamicStep?: number;
  readonly labelOffsetX: number;
  readonly labelOffsetY: number;
  readonly relationshipKind: string;
  readonly technology: string;
};

function c4FamilyPayload(value: MermaidVisualFamilyData | undefined) {
  return mermaidVisualFamilyPayload(value, C4_FAMILY);
}

function details(data: MermaidGfxJsonObject): MermaidC4GfxDetails {
  return {
    description: typeof data.description === "string" ? data.description : "",
    link: typeof data.link === "string" ? data.link : "",
    sprite: typeof data.sprite === "string" ? data.sprite : "",
    tags: typeof data.tags === "string" ? data.tags : "",
  };
}

export function c4BoundaryGfxData(
  subgraph: Pick<MermaidVisualSubgraph, "familyData">,
): MermaidC4BoundaryGfxData | undefined {
  const data = c4FamilyPayload(subgraph.familyData);
  if (!data) return undefined;
  return {
    ...c4BoundaryPresentation(subgraph.familyData),
    sourceParentId:
      typeof data.sourceParentId === "string" ? data.sourceParentId : "",
    boundaryKind:
      typeof data.boundaryKind === "string"
        ? data.boundaryKind
        : "System_Boundary",
    boundaryType:
      typeof data.boundaryType === "string" ? data.boundaryType : "",
    effectiveSprite:
      typeof data.effectiveSprite === "string"
        ? data.effectiveSprite
        : typeof data.sprite === "string"
          ? data.sprite
          : "",
    family: C4_FAMILY,
    label: typeof data.label === "string" ? data.label : "",
    spriteOverridden: data.spriteOverridden === true,
    ...details(data),
  };
}

export function c4NodeGfxData(
  node: Pick<MermaidVisualNode, "familyData">,
): MermaidC4NodeGfxData | undefined {
  const data = c4FamilyPayload(node.familyData);
  if (!data) return undefined;
  return {
    effectiveSprite:
      typeof data.effectiveSprite === "string"
        ? data.effectiveSprite
        : typeof data.sprite === "string"
          ? data.sprite
          : "",
    effectiveTechnology:
      typeof data.effectiveTechnology === "string"
        ? data.effectiveTechnology
        : "",
    family: C4_FAMILY,
    kind: typeof data.kind === "string" ? data.kind : "System",
    sourceTechnology:
      typeof data.sourceTechnology === "string" ? data.sourceTechnology : "",
    spriteOverridden: data.spriteOverridden === true,
    ...details(data),
  };
}

export function c4EdgeGfxData(
  edge: Pick<MermaidVisualEdge, "familyData">,
): MermaidC4EdgeGfxData | undefined {
  const data = c4FamilyPayload(edge.familyData);
  if (!data) return undefined;
  return {
    family: C4_FAMILY,
    index:
      typeof data.index === "string"
        ? data.index
        : typeof data.index === "number" && Number.isFinite(data.index)
          ? String(data.index)
          : null,
    ...(typeof data.dynamicStep === "number" &&
    Number.isInteger(data.dynamicStep) &&
    data.dynamicStep > 0
      ? { dynamicStep: data.dynamicStep }
      : {}),
    labelOffsetX:
      typeof data.labelOffsetX === "number" &&
      Number.isFinite(data.labelOffsetX)
        ? data.labelOffsetX
        : 0,
    labelOffsetY:
      typeof data.labelOffsetY === "number" &&
      Number.isFinite(data.labelOffsetY)
        ? data.labelOffsetY
        : 0,
    relationshipKind:
      typeof data.relationshipKind === "string" ? data.relationshipKind : "Rel",
    technology: typeof data.technology === "string" ? data.technology : "",
    ...details(data),
  };
}

export function c4BoundaryFamilyData({
  collapsed,
  expandedBounds,
  sourceParentId,
  boundaryKind,
  boundaryType,
  description,
  effectiveSprite,
  label,
  link,
  sprite,
  spriteOverridden,
  tags,
  styles,
  nativeNode,
}: Omit<MermaidC4BoundaryGfxData, "family"> & {
  styles?: MermaidGfxJsonObject;
  nativeNode?: boolean;
}): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(C4_FAMILY, {
    ...(styles ? { styles } : {}),
    ...(nativeNode !== undefined ? { nativeNode } : {}),
    ...(collapsed !== undefined ? { collapsed } : {}),
    ...(expandedBounds ? { expandedBounds } : {}),
    sourceParentId,
    boundaryKind,
    boundaryType,
    description,
    effectiveSprite,
    label,
    link,
    sprite,
    spriteOverridden,
    tags,
  });
}

export function c4NodeFamilyData({
  description,
  effectiveSprite,
  effectiveTechnology,
  link,
  kind,
  sourceTechnology,
  sprite,
  spriteOverridden,
  tags,
  styles,
  contentPadding,
}: Omit<MermaidC4NodeGfxData, "family"> & {
  styles?: MermaidGfxJsonObject;
  contentPadding?: number;
}): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(C4_FAMILY, {
    ...(styles ? { styles } : {}),
    ...(contentPadding !== undefined ? { contentPadding } : {}),
    description,
    effectiveSprite,
    effectiveTechnology,
    link,
    kind,
    sourceTechnology,
    sprite,
    spriteOverridden,
    tags,
  });
}

export function c4EdgeFamilyData({
  dynamicStep,
  description,
  index,
  labelOffsetX,
  labelOffsetY,
  link,
  relationshipKind,
  sprite,
  tags,
  technology,
  styles,
}: Omit<MermaidC4EdgeGfxData, "family"> & {
  styles?: MermaidGfxJsonObject;
}): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(C4_FAMILY, {
    ...(styles ? { styles } : {}),
    ...(dynamicStep !== undefined ? { dynamicStep } : {}),
    description,
    index,
    labelOffsetX,
    labelOffsetY,
    link,
    relationshipKind,
    sprite,
    tags,
    technology,
  });
}

export function setMermaidVisualEdgeC4Relationship(
  model: MermaidVisualModel,
  edgeId: string,
  kind: string,
  technology = "",
): MermaidVisualModel {
  return {
    ...model,
    edges: model.edges.map((edge) => {
      if (edge.id !== edgeId) return edge;
      const current = c4EdgeGfxData(edge);
      return {
        ...edge,
        familyData: c4EdgeFamilyData({
          description: current?.description ?? "",
          dynamicStep: current?.dynamicStep,
          index: current?.index ?? null,
          labelOffsetX: current?.labelOffsetX ?? 0,
          labelOffsetY: current?.labelOffsetY ?? 0,
          link: current?.link ?? "",
          relationshipKind: kind.trim() || "Rel",
          sprite: current?.sprite ?? "",
          tags: current?.tags ?? "",
          technology: technology.trim(),
        }),
      };
    }),
  };
}
