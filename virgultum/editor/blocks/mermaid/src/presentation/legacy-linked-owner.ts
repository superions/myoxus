// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FrameBlockModel, MermaidBlockModel } from "@virgultum/model";
import { isGfxGroupCompatibleModel, type GfxModel } from "@virgultum/std/gfx";

export type MermaidLegacyLinkedOwner = {
  readonly childElementIds: readonly string[];
  readonly childElements: readonly GfxModel[];
  readonly frame: FrameBlockModel;
  readonly reference: string;
};

export function readMermaidLegacyReference(model: MermaidBlockModel) {
  const reference = model.yBlock.get("prop:reference");
  return typeof reference === "string" && reference ? reference : null;
}

export function resolveMermaidLegacyLinkedOwner(
  model: MermaidBlockModel,
): MermaidLegacyLinkedOwner | null {
  const reference = readMermaidLegacyReference(model);
  if (!reference) return null;

  const frame = model.store.getBlock(reference)?.model;
  if (frame?.flavour !== "myoxus:frame" || !isGfxGroupCompatibleModel(frame)) {
    return null;
  }

  return {
    childElementIds: [...frame.childIds],
    childElements: [...frame.childElements],
    frame: frame as FrameBlockModel,
    reference,
  };
}
