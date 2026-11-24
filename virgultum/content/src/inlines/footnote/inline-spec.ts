import { FootNoteSchema } from "@virgultum/core/models";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { StdIdentifier } from "@virgultum/core/runtime";
import { InlineSpecExtension } from "@virgultum/core/runtime/inline";
import { inlineChild } from "@virgultum/core/runtime/inline";
import z from "zod";

import { FootNoteNodeConfigIdentifier } from "./footnote-node/footnote-config";

export const FootNoteInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("footnote", (provider) => {
    const std = provider.get(StdIdentifier);
    const config =
      provider.getOptional(FootNoteNodeConfigIdentifier) ?? undefined;
    return {
      name: "footnote",
      schema: z.object({
        footnote: FootNoteSchema.optional().nullable().catch(undefined),
      }),
      match: (delta) => {
        return !!delta.attributes?.footnote;
      },
      renderer: ({ delta }, parent) => {
        return inlineChild(parent, "myoxus-footnote-node", {
          delta,
          std,
          config,
        });
      },
      embed: true,
    };
  });
