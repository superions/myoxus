import { CommentInlineSpecExtension } from "@virgultum/inline-comment";
import { FootNoteInlineSpecExtension } from "@virgultum/inline-footnote";
import { LatexInlineSpecExtension } from "@virgultum/inline-latex";
import { LinkInlineSpecExtension } from "@virgultum/inline-link";
import { MentionInlineSpecExtension } from "@virgultum/inline-mention";
import { ReferenceInlineSpecExtension } from "@virgultum/inline-reference";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { InlineManagerExtension } from "@virgultum/std/inline";

import {
  AnnotationInlineSpecExtension,
  BackgroundInlineSpecExtension,
  BoldInlineSpecExtension,
  CodeInlineSpecExtension,
  ColorInlineSpecExtension,
  ItalicInlineSpecExtension,
  LabelToneInlineSpecExtension,
  StrikeInlineSpecExtension,
  UnderlineInlineSpecExtension,
} from "./inline-spec";

export const DefaultInlineManagerExtension =
  InlineManagerExtension<MyoxusTextAttributes>({
    id: "DefaultInlineManager",
    specs: [
      BoldInlineSpecExtension.identifier,
      ItalicInlineSpecExtension.identifier,
      UnderlineInlineSpecExtension.identifier,
      StrikeInlineSpecExtension.identifier,
      CodeInlineSpecExtension.identifier,
      BackgroundInlineSpecExtension.identifier,
      ColorInlineSpecExtension.identifier,
      LabelToneInlineSpecExtension.identifier,
      LatexInlineSpecExtension.identifier,
      ReferenceInlineSpecExtension.identifier,
      LinkInlineSpecExtension.identifier,
      FootNoteInlineSpecExtension.identifier,
      MentionInlineSpecExtension.identifier,
      CommentInlineSpecExtension.identifier,
      AnnotationInlineSpecExtension.identifier,
    ],
  });
