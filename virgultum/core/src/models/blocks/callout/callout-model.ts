import type { IconData } from "../../../services/index";
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  Text,
} from "../../../store/index";

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

type Settings = { type: string; foldable: boolean; defaultOpen: boolean };
export class CalloutBlockModel extends BlockModel<CalloutProps> {
  private get editable() {
    return (
      !this.store.readonly &&
      this.props.textProtection !== "fixed" &&
      this.store.getModelById(this.id) === this
    );
  }
  /** An open title editor must not overwrite a newer title from a peer. */
  applyTitle(value: string, base: string) {
    const current = this.props.title;
    if (
      !this.editable ||
      /[\r\n]/.test(value) ||
      (current?.toString() ?? "") !== base
    )
      return false;
    if (value === base) return true;
    this.store.captureSync();
    if (current) current.replace(0, current.length, value, {});
    else this.store.updateBlock(this, { title: new Text(value) });
    this.store.captureSync();
    return true;
  }
  applySettings(value: Settings, base: Settings) {
    if (
      !this.editable ||
      this.props.type !== base.type ||
      (this.props.foldable === true) !== base.foldable ||
      (this.props.defaultOpen !== false) !== base.defaultOpen ||
      !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value.type)
    )
      return false;
    if (
      value.type === base.type &&
      value.foldable === base.foldable &&
      value.defaultOpen === base.defaultOpen
    )
      return true;
    const presentation = calloutPresentation(value.type);
    this.store.captureSync();
    this.store.updateBlock(this, {
      ...value,
      ...(value.type !== base.type
        ? {
            icon: { type: "emoji", unicode: presentation.icon },
            backgroundColorName: presentation.background,
          }
        : {}),
    });
    this.store.captureSync();
    return true;
  }
}

export const CalloutBlockSchemaExtension =
  BlockSchemaExtension(CalloutBlockSchema);
