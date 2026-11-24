import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { StdIdentifier } from "@virgultum/core/runtime";
import { InlineSpecExtension } from "@virgultum/core/runtime/inline";
import { inlineChild } from "@virgultum/core/runtime/inline";
import { z } from "zod";

export const MentionInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("mention", (provider) => {
    const std = provider.get(StdIdentifier);
    return {
      name: "mention",
      schema: z.object({
        mention: z
          .object({
            member: z.string(),
            notification: z.string().optional(),
          })
          .optional()
          .nullable()
          .catch(undefined),
      }),
      match: (delta) => {
        return !!delta.attributes?.mention?.member;
      },
      renderer: ({ delta, selected }, parent) => {
        return inlineChild(parent, "myoxus-mention", { delta, std, selected });
      },
      embed: true,
    };
  });
