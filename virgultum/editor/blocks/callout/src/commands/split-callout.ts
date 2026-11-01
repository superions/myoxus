import { CalloutBlockModel, ParagraphBlockModel } from "@virgultum/model";
import { focusTextModel } from "@virgultum/rich-text";
import { matchModels } from "@virgultum/shared/utils";
import type { Command, EditorHost } from "@virgultum/std";
import { Text } from "@virgultum/store";

export const splitCalloutCommand: Command<{
  blockId: string;
  inlineIndex: number;
  currentBlockId: string;
}> = (ctx, next) => {
  const { blockId, inlineIndex, currentBlockId, std } = ctx;
  const host = std.host as EditorHost;
  const doc = host.store;
  if (doc.readonly) return;

  const calloutModel = doc.getBlock(blockId)?.model;
  if (!calloutModel || !matchModels(calloutModel, [CalloutBlockModel])) {
    console.error(`block ${blockId} is not a callout block`);
    return;
  }

  const currentModel = doc.getBlock(currentBlockId)?.model;
  if (!currentModel) {
    console.error(`current block ${currentBlockId} not found`);
    return;
  }
  if (
    currentModel !== calloutModel &&
    doc.getParent(currentModel) !== calloutModel
  )
    return;

  doc.captureSync();

  if (matchModels(currentModel, [ParagraphBlockModel, CalloutBlockModel])) {
    // Text.split already removes the tail while preserving all delta marks.
    const afterText = currentModel.props.text.split(inlineIndex);

    // Create a new paragraph block after the current one
    const parent =
      currentModel === calloutModel
        ? calloutModel
        : doc.getParent(currentModel);
    if (parent) {
      // Own body precedes every child, so its split inserts the first child.
      const currentIndex =
        currentModel === calloutModel
          ? -1
          : parent.children.indexOf(currentModel);
      const newParagraphId = doc.addBlock(
        "myoxus:paragraph",
        {
          text: afterText,
        },
        parent,
        currentIndex + 1,
      );

      if (newParagraphId) {
        host.updateComplete
          .then(() => {
            focusTextModel(std, newParagraphId);
          })
          .catch(console.error);
      }
    }
  } else {
    // If current block is not a paragraph, create a new paragraph in callout
    const newParagraphId = doc.addBlock(
      "myoxus:paragraph",
      {
        text: new Text(),
      },
      calloutModel,
    );

    if (newParagraphId) {
      host.updateComplete
        .then(() => {
          focusTextModel(std, newParagraphId);
        })
        .catch(console.error);
    }
  }

  next();
};
