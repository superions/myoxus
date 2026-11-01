import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { StdIdentifier } from "@virgultum/std";
import { InlineSpecExtension } from "@virgultum/std/inline";
import { html } from "lit";
import { z } from "zod";

export const LinkInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("link", (provider) => {
    const std = provider.get(StdIdentifier);
    return {
      name: "link",
      schema: z.object({
        link: z.string().optional().nullable().catch(undefined),
      }),
      match: (delta) => {
        return !!delta.attributes?.link;
      },
      renderer: ({ delta }) => {
        return html`<myoxus-link .std=${std} .delta=${delta}></myoxus-link>`;
      },
    };
  });
