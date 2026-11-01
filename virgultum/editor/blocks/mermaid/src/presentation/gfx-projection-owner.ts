// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidBlockModel } from "@virgultum/model";
import type { SerializedXYWH } from "@virgultum/global/gfx";
import type { FrameBlockModel } from "@virgultum/model";
import type { GfxModel } from "@virgultum/std/gfx";

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
