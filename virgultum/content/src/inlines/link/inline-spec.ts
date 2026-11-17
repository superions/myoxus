import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { StdIdentifier } from "@virgultum/core/runtime";
import { InlineSpecExtension } from "@virgultum/core/runtime/inline";
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
