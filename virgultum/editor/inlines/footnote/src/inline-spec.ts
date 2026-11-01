import { FootNoteSchema } from "@virgultum/model";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { StdIdentifier } from "@virgultum/std";
import { InlineSpecExtension } from "@virgultum/std/inline";
import { html } from "lit";
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
      renderer: ({ delta }) => {
        return html`<myoxus-footnote-node
          .delta=${delta}
          .std=${std}
          .config=${config}
        ></myoxus-footnote-node>`;
      },
      embed: true,
    };
  });
