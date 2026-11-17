import { ListBlockModel, ParagraphBlockModel } from "@virgultum/core/models";
import { calculateCollapsedSiblings, matchModels } from "@virgultum/core/utils";
import type { Command } from "@virgultum/core/runtime";

/**
 * @example
 * before indent:
 * - aaa
 *   - bbb
 * - ccc|
 *   - ddd
 *   - eee
 *
 * after indent:
 * - aaa
 *   - bbb
 *   - ccc|
 *     - ddd
 *     - eee
 */
export const indentBlock: Command<{
  blockId?: string;
  stopCapture?: boolean;
}> = (ctx, next) => {
  let { blockId } = ctx;
  const { std, stopCapture = true } = ctx;
  const { store } = std;
  const { schema } = store;
  if (!blockId) {
    const sel = std.selection.getGroup("note").at(0);
    blockId = sel?.blockId;
  }
  if (!blockId) return;
  const model = std.store.getBlock(blockId)?.model;
  if (!model) return;

  const previousSibling = store.getPrev(model);
  if (
    store.readonly ||
    !previousSibling ||
    !schema.isValid(model.flavour, previousSibling.flavour)
  ) {
    // can not indent, do nothing
    return;
  }

  if (stopCapture) store.captureSync();

  if (
    matchModels(model, [ParagraphBlockModel]) &&
    model.props.type.startsWith("h") &&
    model.props.collapsed
  ) {
    const collapsedSiblings = calculateCollapsedSiblings(model);
    store.moveBlocks([model, ...collapsedSiblings], previousSibling);
  } else {
    store.moveBlocks([model], previousSibling);
  }

  // Update the list's collapsed state.
  if (
    matchModels(previousSibling, [ListBlockModel]) &&
    previousSibling.props.collapsed
  ) {
    store.updateBlock(previousSibling, {
      collapsed: false,
    });
  }

  return next();
};
