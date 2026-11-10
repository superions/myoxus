import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { StdIdentifier } from "@virgultum/std";
import { InlineSpecExtension } from "@virgultum/std/inline";
import { html } from "lit";
import { z } from "zod";

export const LatexInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("latex", (provider) => {
    const std = provider.get(StdIdentifier);
    return {
      name: "latex",
      schema: z.object({
        latex: z.string().optional().nullable().catch(undefined),
      }),
      match: (delta) => typeof delta.attributes?.latex === "string",
      renderer: ({ delta, selected, editor, startOffset, endOffset }) => {
        return html`<myoxus-latex-node
          .std=${std}
          .delta=${delta}
          .selected=${selected}
          .editor=${editor}
          .startOffset=${startOffset}
          .endOffset=${endOffset}
        ></myoxus-latex-node>`;
      },
      embed: true,
    };
  });

export const LatexEditorUnitSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "latex-editor-unit",
    schema: z.object({
      // This renderer marker is not a persisted text attribute.
      "latex-editor-unit": z.undefined().optional(),
    }),
    match: () => true,
    renderer: ({ delta }) => {
      return html`<latex-editor-unit .delta=${delta}></latex-editor-unit>`;
    },
  });
