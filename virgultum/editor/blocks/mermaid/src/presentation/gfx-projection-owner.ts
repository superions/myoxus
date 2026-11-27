// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidBlockModel } from "@virgultum/core/models";
import { Bound, type SerializedXYWH } from "@virgultum/core/primitives/gfx";
import type { FrameBlockModel } from "@virgultum/core/models";
import type { GfxModel } from "@virgultum/core/runtime/gfx";

import { getMermaidGfxTitleBandHeight } from "../families/runtime/gfx-element-projection.js";
import { MERMAID_GFX_TITLE_ROLE } from "../families/runtime/gfx-element-roles.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxNodeId,
  readMermaidGfxRole,
} from "../mermaid-gfx-metadata.js";
import { resolveMermaidLegacyLinkedOwner } from "./legacy-linked-owner.js";

export type MermaidGfxProjectionOwner = {
  readonly childElementIds: readonly string[];
  readonly getElementById: (id: string) => GfxModel | null;
  readonly model: MermaidBlockModel;
  readonly surface: NonNullable<MermaidBlockModel["surface"]>;
};

export type MermaidGfxProjection = {
  readonly childElementIds: readonly string[];
  readonly displayOnly: boolean;
  readonly getElementById: (id: string) => GfxModel | null;
  readonly kind: "direct" | "legacy";
  readonly owner: MermaidBlockModel | FrameBlockModel;
  readonly ownerId: string;
  readonly ownerXYWH: SerializedXYWH;
  readonly surfaceId: string;
};

export function resolveMermaidGfxProjectionOwner(
  model: MermaidBlockModel,
): MermaidGfxProjectionOwner | null {
  const surface = model.surface;
  if (!surface) return null;

  return {
    get childElementIds() {
      return model.childIds;
    },
    getElementById: (id) =>
      (surface.getElementById(id) ??
        surface.store.getModelById(id) ??
        null) as GfxModel | null,
    model,
    surface,
  };
}

/**
 * Resolve the one GFX projection consumed by a Mermaid block.
 *
 * New blocks own their children directly. Retained linked data is deliberately
 * a read-only fallback for persisted documents that have not reached the 3D.9
 * migration yet; callers must honour `displayOnly` and never turn that adapter
 * into another mutation or history owner.
 */
export function resolveMermaidGfxProjection(
  model: MermaidBlockModel,
): MermaidGfxProjection | null {
  const direct = resolveMermaidGfxProjectionOwner(model);
  const legacy = resolveMermaidLegacyLinkedOwner(model);
  if (direct && (direct.childElementIds.length > 0 || !legacy)) {
    const surfaceId = model.store.getBlocksByFlavour("myoxus:surface").at(0)
      ?.model.id;
    if (!surfaceId) return null;
    return {
      childElementIds: direct.childElementIds,
      displayOnly: false,
      getElementById: direct.getElementById,
      kind: "direct",
      owner: model,
      ownerId: model.id,
      ownerXYWH: model.xywh,
      surfaceId,
    };
  }

  const surfaceId = model.store.getBlocksByFlavour("myoxus:surface").at(0)
    ?.model.id;
  if (!legacy || !surfaceId) return null;
  return {
    childElementIds: legacy.childElementIds,
    displayOnly: true,
    getElementById: (id) =>
      (legacy.frame.surface?.getElementById(id) ??
        model.store.getModelById(id) ??
        null) as GfxModel | null,
    kind: "legacy",
    owner: legacy.frame,
    ownerId: legacy.frame.id,
    ownerXYWH: legacy.frame.xywh,
    surfaceId,
  };
}

/**
 * Project a Mermaid GFX owner for Page / embedded block-shell viewports.
 *
 * Surface-owned diagrams materialize a presentation-only native title child
 * (`MERMAID_GFX_TITLE_ROLE`) plus a top title band for Edgeless, which has no
 * block shell header. Page viewports already render the single editable title
 * in `MermaidBlockShell`, so they must omit that native title element and trim
 * its reserved top band instead of showing an uneditable duplicate title.
 */
export function projectMermaidGfxForPageViewport(
  projection: MermaidGfxProjection,
  {
    hiddenObjectKeys,
    visualModel,
  }: {
    readonly hiddenObjectKeys?: ReadonlySet<string>;
    readonly visualModel?: MermaidVisualModel | null;
  } = {},
): MermaidGfxProjection {
  let hasNativeTitleChild = false;
  const childElementIds: string[] = [];
  const semanticShapeBounds: Bound[] = [];

  for (const id of projection.childElementIds) {
    const element = projection.getElementById(id);
    const role = readMermaidGfxRole(element);
    if (role === MERMAID_GFX_TITLE_ROLE) {
      hasNativeTitleChild = true;
      continue;
    }
    if (
      hiddenObjectKeys?.size &&
      (hiddenObjectKeys.has(readMermaidGfxNodeId(element)) ||
        hiddenObjectKeys.has(readMermaidGfxEdgeId(element)))
    ) {
      continue;
    }
    childElementIds.push(id);
    if (
      element &&
      "type" in element &&
      element.type === "shape" &&
      "xywh" in element &&
      typeof element.xywh === "string"
    ) {
      semanticShapeBounds.push(Bound.deserialize(element.xywh));
    }
  }

  let ownerXYWH = projection.ownerXYWH;
  if (hasNativeTitleChild) {
    const ownerBound = Bound.deserialize(projection.ownerXYWH);
    const titleBandHeight = getMermaidGfxTitleBandHeight(visualModel);
    if (
      titleBandHeight > 0 &&
      semanticShapeBounds.length > 0 &&
      semanticShapeBounds.every(
        (bound) => bound.y >= ownerBound.y + titleBandHeight,
      )
    ) {
      ownerXYWH = new Bound(
        ownerBound.x,
        ownerBound.y + titleBandHeight,
        ownerBound.w,
        Math.max(1, ownerBound.h - titleBandHeight),
      ).serialize();
    }
  }

  if (
    !hasNativeTitleChild &&
    childElementIds.length === projection.childElementIds.length &&
    ownerXYWH === projection.ownerXYWH
  ) {
    return projection;
  }

  return {
    ...projection,
    childElementIds,
    ownerXYWH,
  };
}
