import type { IconData } from "@virgultum/shared/services";
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";

import type { BlockMeta, TextProtection } from "../../utils/types";

export type CalloutAppearance = "soft" | "accent" | "outline";

/** Existing highlight roles only; unknown authored kinds remain neutral. */
export function calloutPresentation(kind: string) {
  switch (kind.toLowerCase()) {
    case "warning":
    case "caution":
    case "attention":
      return { icon: "⚠️", background: "yellow" };
    case "danger":
    case "error":
    case "failure":
    case "fail":
    case "missing":
    case "bug":
      return { icon: "⛔", background: "red" };
    case "tip":
    case "hint":
    case "important":
      return { icon: "💡", background: "green" };
    case "success":
    case "check":
    case "done":
      return { icon: "✅", background: "green" };
    case "question":
    case "help":
    case "faq":
      return { icon: "❓", background: "yellow" };
    case "info":
    case "todo":
    case "abstract":
    case "summary":
    case "tldr":
      return { icon: "ℹ️", background: "blue" };
    case "example":
      return { icon: "💡", background: "purple" };
    case "quote":
    case "cite":
      return { icon: "💬", background: "grey" };
    default:
      return { icon: "💡", background: "grey" };
  }
}

export type CalloutProps = {
  /** Semantic Markdown kind, independent of presentation; absent on legacy callouts. */
  type?: string;
  /** Canonical custom title; absent/empty uses the kind's display label. */
  title?: Text;
  foldable?: boolean;
  /** Authored initial state; viewing toggles never change this property. */
  defaultOpen?: boolean;
  icon?: IconData;
  text: Text;
  textProtection?: TextProtection;
  backgroundColorName?: string;
  /** Absent values retain the original soft callout presentation. */
  appearance?: CalloutAppearance;
  markdownAnchor?: string;
} & BlockMeta;

export const normalizeCalloutAppearance = (
  value: unknown,
): CalloutAppearance | undefined =>
  value === "soft" || value === "accent" || value === "outline"
    ? value
    : undefined;

export const CalloutBlockSchema = defineBlockSchema({
  flavour: "myoxus:callout",
  props: (internal): CalloutProps => ({
    icon: { type: "emoji", unicode: "💡" } as IconData,
    text: internal.Text(),
    textProtection: undefined,
    backgroundColorName: "grey",
    appearance: undefined,
    markdownAnchor: undefined,
    type: undefined,
    title: undefined,
    foldable: undefined,
    defaultOpen: undefined,
    "meta:createdAt": undefined,
    "meta:updatedAt": undefined,
    "meta:createdBy": undefined,
    "meta:updatedBy": undefined,
  }),
  metadata: {
    version: 1,
    role: "hub",
    parent: [
      "myoxus:footnote-definition",
      "myoxus:note",
      "myoxus:database",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:edgeless-text",
      "myoxus:transcription",
      "myoxus:callout",
    ],
    children: [
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:callout",
      "myoxus:code",
      "myoxus:annotation",
    ],
  },
  toModel: () => new CalloutBlockModel(),
});

export class CalloutBlockModel extends BlockModel<CalloutProps> {}

export const CalloutBlockSchemaExtension =
  BlockSchemaExtension(CalloutBlockSchema);
