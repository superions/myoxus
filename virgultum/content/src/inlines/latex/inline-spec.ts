import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { StdIdentifier } from "@virgultum/core/runtime";
import { InlineSpecExtension } from "@virgultum/core/runtime/inline";
import { inlineChild } from "@virgultum/core/runtime/inline";
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
      renderer: (
        { delta, selected, editor, startOffset, endOffset },
        parent,
      ) => {
        return inlineChild(parent, "myoxus-latex-node", {
          std,
          delta,
          selected,
          editor,
          startOffset,
          endOffset,
        });
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
    renderer: ({ delta }, parent) => {
      return inlineChild(parent, "latex-editor-unit", { delta });
    },
  });
