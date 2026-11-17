// SPDX-License-Identifier: MIT

import {
  type BlockComponent,
  BlockSelection,
  type Command,
} from "../runtime/index";

/** Select the focused block in the existing note group without changing history. */
export const selectBlock: Command<{
  focusBlock?: BlockComponent;
}> = (ctx, next) => {
  const { focusBlock, std } = ctx;
  if (!focusBlock) {
    return;
  }

  const { selection } = std;

  selection.setGroup("note", [
    selection.create(BlockSelection, { blockId: focusBlock.blockId }),
  ]);

  return next();
};
