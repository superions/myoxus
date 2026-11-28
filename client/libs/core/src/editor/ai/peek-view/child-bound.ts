// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/editor/blocks/surface";
import { Bound } from "@virgultum/editor/global/gfx";
import type { BlockStdScope } from "@virgultum/editor/std";

import {
  type AIChatBlockModel,
  CHAT_BLOCK_HEIGHT,
  CHAT_BLOCK_WIDTH,
} from "../blocks";

const VERTICAL_BRANCH_GAP = 60;

/**
 * Computes canvas coordinates for a newly branched AI chat block to the right
 * of `parentModel`, alternating vertically around existing connected branches.
 */
export function computeBranchChatBound(
  parentModel: AIChatBlockModel,
  std: BlockStdScope,
): Bound {
  const surface = getSurfaceBlock(std.store);
  const crud = std.get(EdgelessCRUDIdentifier);
  const parentRect = Bound.deserialize(parentModel.xywh);
  const defaultX = parentRect.x + parentRect.w + CHAT_BLOCK_WIDTH;
  const defaultY = parentRect.y;

  const outgoingConnectors =
    surface
      ?.getConnectors(parentModel.id)
      .filter((conn) => conn.source.id === parentModel.id) ?? [];
  if (!outgoingConnectors.length) {
    return new Bound(defaultX, defaultY, CHAT_BLOCK_WIDTH, CHAT_BLOCK_HEIGHT);
  }

  const siblings = outgoingConnectors
    .map((conn) => conn.target.id)
    .filter((id): id is string => Boolean(id))
    .map((id) => crud.getElementById(id))
    .filter((el): el is NonNullable<typeof el> => Boolean(el))
    .sort((a, b) => Bound.deserialize(a.xywh).y - Bound.deserialize(b.xywh).y);

  if (!siblings.length) {
    return new Bound(defaultX, defaultY, CHAT_BLOCK_WIDTH, CHAT_BLOCK_HEIGHT);
  }

  const last = Bound.deserialize(siblings[siblings.length - 1].xywh);
  if (siblings.length % 2 === 1) {
    return new Bound(
      last.x,
      last.y + last.h + VERTICAL_BRANCH_GAP,
      CHAT_BLOCK_WIDTH,
      CHAT_BLOCK_HEIGHT,
    );
  }

  const middle = Bound.deserialize(
    siblings[Math.floor((siblings.length - 1) / 2)].xywh,
  );
  const mirroredGap = last.y - (middle.y + middle.h);
  return new Bound(
    last.x,
    middle.y - mirroredGap - CHAT_BLOCK_HEIGHT,
    CHAT_BLOCK_WIDTH,
    CHAT_BLOCK_HEIGHT,
  );
}
