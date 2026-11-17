import { CommentInlineSpecExtension } from "../../inlines/comment/index";
import { LatexInlineSpecExtension } from "../../inlines/latex/index";
import { LinkInlineSpecExtension } from "../../inlines/link/index";
import {
  BackgroundInlineSpecExtension,
  BoldInlineSpecExtension,
  CodeInlineSpecExtension,
  ColorInlineSpecExtension,
  ItalicInlineSpecExtension,
  StrikeInlineSpecExtension,
  UnderlineInlineSpecExtension,
} from "../../inlines/preset/index";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import {
  InlineManagerExtension,
  InlineSpecExtension,
} from "@virgultum/core/runtime/inline";
import { html } from "lit";
import { z } from "zod";

export const CodeBlockUnitSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "code-block-unit",
    schema: z.object({
      // This renderer marker is not a persisted text attribute.
      "code-block-uint": z.undefined().optional(),
    }),
    match: () => true,
    renderer: ({ delta }) => {
      return html`<myoxus-code-unit .delta=${delta}></myoxus-code-unit>`;
    },
  });

export const CodeBlockInlineManagerExtension =
  InlineManagerExtension<MyoxusTextAttributes>({
    id: "CodeBlockInlineManager",
    enableMarkdown: false,
    specs: [
      BoldInlineSpecExtension.identifier,
      ItalicInlineSpecExtension.identifier,
      UnderlineInlineSpecExtension.identifier,
      StrikeInlineSpecExtension.identifier,
      CodeInlineSpecExtension.identifier,
      BackgroundInlineSpecExtension.identifier,
      ColorInlineSpecExtension.identifier,
      LatexInlineSpecExtension.identifier,
      LinkInlineSpecExtension.identifier,
      CodeBlockUnitSpecExtension.identifier,
      CommentInlineSpecExtension.identifier,
    ],
  });
