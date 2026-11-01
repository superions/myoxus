// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Store } from "@virgultum/store";
import type { GfxModel } from "@virgultum/std/gfx";

import { isMermaidBlockModel } from "./owner.js";
import {
  resolveMermaidGfxProjection,
  resolveMermaidGfxProjectionOwner,
  type MermaidGfxProjectionOwner,
} from "./gfx-projection-owner.js";

export type MermaidNativeEdgelessOwner = MermaidGfxProjectionOwner;

export function resolveNativeMermaidOwner(
  model: unknown,
): MermaidNativeEdgelessOwner | null {
  if (!isMermaidBlockModel(model)) return null;
  if (model.store.getParent(model.id)?.flavour !== "myoxus:surface") {
    return null;
  }
  if (resolveMermaidGfxProjection(model)?.displayOnly) return null;
  return resolveMermaidGfxProjectionOwner(model);
}

function ownerFromGfxModel(model: GfxModel) {
  const direct = resolveNativeMermaidOwner(model);
  if (direct) return direct;
  for (const group of model.groups) {
    const owner = resolveNativeMermaidOwner(group);
    if (owner) return owner;
  }
  return null;
}

export function resolveNativeMermaidOwnerForSelection(
  store: Store,
  models: readonly GfxModel[],
  current?: unknown,
): MermaidNativeEdgelessOwner | null {
  const candidates = models.length
    ? models.map(ownerFromGfxModel)
    : [resolveNativeMermaidOwner(current)];
  if (candidates.some((candidate) => !candidate)) return null;
  const owner = candidates[0] ?? null;
  if (!owner) return null;
  if (candidates.some((candidate) => candidate?.model.id !== owner.model.id)) {
    return null;
  }
  return store.getBlock(owner.model.id)?.model === owner.model ? owner : null;
}
