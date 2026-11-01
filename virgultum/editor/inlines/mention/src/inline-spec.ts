import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { StdIdentifier } from "@virgultum/std";
import { InlineSpecExtension } from "@virgultum/std/inline";
import { html } from "lit";
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
      renderer: ({ delta, selected }) => {
        return html`<myoxus-mention
          .delta=${delta}
          .std=${std}
          .selected=${selected}
        ></myoxus-mention>`;
      },
      embed: true,
    };
  });
