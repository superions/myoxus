import type {} from "./link-node/myoxus-link";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { StdIdentifier } from "@virgultum/core/runtime";
import { InlineSpecExtension } from "@virgultum/core/runtime/inline";
import { inlineChild } from "@virgultum/core/runtime/inline";
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
      renderer: ({ delta }, parent) => {
        return inlineChild(parent, "myoxus-link", { std, delta });
      },
    };
  });
