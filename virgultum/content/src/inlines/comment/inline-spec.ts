import {
  type CommentId,
  CommentProviderIdentifier,
} from "@virgultum/core/services";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import {
  dynamicSchema,
  inlineChild,
  InlineSpecExtension,
} from "@virgultum/core/runtime/inline";
import { z } from "zod";

import { extractCommentIdFromDelta } from "./utils";

type InlineCommendId = `comment-${CommentId}`;
function isInlineCommendId(key: string): key is InlineCommendId {
  return key.startsWith("comment-");
}

export const CommentInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("comment", (scope) => ({
    name: "comment",
    schema: dynamicSchema(
      isInlineCommendId,
      z.boolean().optional().nullable().catch(undefined),
    ),
    match: (delta) => {
      if (!delta.attributes) return false;
      const comments = Object.keys(delta.attributes).filter(isInlineCommendId);
      return comments.length > 0;
    },
    renderer: ({ delta }, parent) =>
      inlineChild(parent, "inline-comment", {
        provider: scope.getOptional(CommentProviderIdentifier) ?? undefined,
        unresolved: Object.entries(delta.attributes ?? {}).some(
          ([key, value]) => isInlineCommendId(key) && value === true,
        ),
        commentIds: extractCommentIdFromDelta(delta),
      }),
    wrapper: true,
  }));

export const NullCommentInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "comment",
    schema: dynamicSchema(
      isInlineCommendId,
      z.boolean().optional().nullable().catch(undefined),
    ),
    match: () => false,
    renderer: (_props, parent) => parent,
  });

// reuse the same identifier
NullCommentInlineSpecExtension.identifier =
  CommentInlineSpecExtension.identifier;
