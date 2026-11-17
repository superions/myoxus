import { CommentInlineSpecExtension } from "../comment/index";
import { FootNoteInlineSpecExtension } from "../footnote/index";
import { LatexInlineSpecExtension } from "../latex/index";
import { LinkInlineSpecExtension } from "../link/index";
import { MentionInlineSpecExtension } from "../mention/index";
import { ReferenceInlineSpecExtension } from "../reference/index";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { InlineManagerExtension } from "@virgultum/core/runtime/inline";

import {
  AnnotationInlineSpecExtension,
  BackgroundInlineSpecExtension,
  BoldInlineSpecExtension,
  CodeInlineSpecExtension,
  ColorInlineSpecExtension,
  DocumentFieldInlineSpecExtension,
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
      DocumentFieldInlineSpecExtension.identifier,
    ],
  });
