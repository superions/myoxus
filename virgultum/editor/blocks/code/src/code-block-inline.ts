import { CommentInlineSpecExtension } from "@virgultum/inline-comment";
import { LatexInlineSpecExtension } from "@virgultum/inline-latex";
import { LinkInlineSpecExtension } from "@virgultum/inline-link";
import {
  BackgroundInlineSpecExtension,
  BoldInlineSpecExtension,
  CodeInlineSpecExtension,
  ColorInlineSpecExtension,
  ItalicInlineSpecExtension,
  StrikeInlineSpecExtension,
  UnderlineInlineSpecExtension,
} from "@virgultum/inline-preset";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import {
  InlineManagerExtension,
  InlineSpecExtension,
} from "@virgultum/std/inline";
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
