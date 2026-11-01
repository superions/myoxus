import { AnnotationSchema } from "@virgultum/model";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import {
  type InlineRootElement,
  InlineSpecExtension,
} from "@virgultum/std/inline";
import type { ExtensionType } from "@virgultum/store";
import { StdIdentifier } from "@virgultum/std";
import { html } from "lit";
import { z } from "zod";

export type MyoxusInlineRootElement = InlineRootElement<MyoxusTextAttributes>;

export const AnnotationInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("annotation", (provider) => ({
    name: "annotation",
    schema: z.object({
      annotation: AnnotationSchema.optional().nullable().catch(undefined),
    }),
    match: (delta) =>
      AnnotationSchema.safeParse(delta.attributes?.annotation).success,
    embed: (delta) => AnnotationSchema.parse(delta.attributes?.annotation).id,
    renderer: ({ delta, editor, startOffset }) =>
      html`<myoxus-inline-annotation
        .delta=${delta}
        .editor=${editor}
        .startOffset=${startOffset}
        .std=${provider.get(StdIdentifier)}
      ></myoxus-inline-annotation>`,
  }));

export const BoldInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>({
    name: "bold",
    schema: z.object({
      bold: z.literal(true).optional().nullable().catch(undefined),
    }),
    match: (delta) => {
      return !!delta.attributes?.bold;
    },
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
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
    renderer: ({ delta }) => {
      return html`<myoxus-text .delta=${delta}></myoxus-text>`;
    },
  });

export const InlineSpecExtensions: ExtensionType[] = [
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
