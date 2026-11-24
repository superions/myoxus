import { AnnotationSchema } from "@virgultum/core/models";
import { DocumentFieldSchema } from "@virgultum/core/types";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import {
  inlineChild,
  type AttributeRenderer,
  type InlineRootElement,
  InlineSpecExtension,
} from "@virgultum/core/runtime/inline";
import type { ExtensionType } from "@virgultum/core/store";
import { StdIdentifier } from "@virgultum/core/runtime";
import { z } from "zod";

export type MyoxusInlineRootElement = InlineRootElement<MyoxusTextAttributes>;

// Captured runs use ordinary typography rather than live interactive embeds.
export const DocumentFieldInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("document-field", (provider) => ({
    name: "document-field",
    schema: z.object({
      documentField: DocumentFieldSchema.optional().nullable(),
      documentFieldCaptured: z.literal(true).optional().nullable(),
    }),
    match: (delta) =>
      !!delta.attributes?.documentField &&
      !delta.attributes.documentFieldCaptured,
    embed: true,
    renderer: ({ delta, editor, startOffset }, parent) =>
      inlineChild(parent, "myoxus-inline-document-field", {
        delta,
        editor,
        startOffset,
        std: provider.get(StdIdentifier),
      }),
  }));

export const AnnotationInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("annotation", (provider) => ({
    name: "annotation",
    schema: z.object({
      annotation: AnnotationSchema.optional().nullable().catch(undefined),
    }),
    match: (delta) =>
      AnnotationSchema.safeParse(delta.attributes?.annotation).success,
    embed: (delta) => AnnotationSchema.parse(delta.attributes?.annotation).id,
    renderer: ({ delta, editor, startOffset }, parent) =>
      inlineChild(parent, "myoxus-inline-annotation", {
        delta,
        editor,
        startOffset,
        std: provider.get(StdIdentifier),
      }),
  }));

const renderText: AttributeRenderer<MyoxusTextAttributes> = (
  { delta },
  parent,
) => inlineChild(parent, "myoxus-text", { delta });

export const BoldInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "bold",
    schema: z.object({
      bold: z.literal(true).optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.bold;
    },
    renderer: renderText,
  });

export const ItalicInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "italic",
    schema: z.object({
      italic: z.literal(true).optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.italic;
    },
    renderer: renderText,
  });

export const UnderlineInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "underline",
    schema: z.object({
      underline: z.literal(true).optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.underline;
    },
    renderer: renderText,
  });

export const StrikeInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "strike",
    schema: z.object({
      strike: z.literal(true).optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.strike;
    },
    renderer: renderText,
  });

export const CodeInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "inline-code",
    schema: z.object({
      code: z.literal(true).optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.code;
    },
    renderer: renderText,
  });

export const BackgroundInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "background",
    schema: z.object({
      background: z.string().optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.background;
    },
    renderer: renderText,
  });

export const ColorInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "color",
    schema: z.object({
      color: z.string().optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.color;
    },
    renderer: renderText,
  });

export const LabelToneInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "label-tone",
    schema: z.object({
      labelTone: z
        .enum(["neutral", "info", "positive", "warning", "danger", "accent"])
        .optional()
        .nullable()
        .catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.labelTone;
    },
    renderer: renderText,
  });

export const InlineSpecExtensions: ExtensionType[] = [
  DocumentFieldInlineSpecExtension,
  AnnotationInlineSpecExtension,
  BoldInlineSpecExtension,
  ItalicInlineSpecExtension,
  UnderlineInlineSpecExtension,
  StrikeInlineSpecExtension,
  CodeInlineSpecExtension,
  BackgroundInlineSpecExtension,
  ColorInlineSpecExtension,
  LabelToneInlineSpecExtension,
];
