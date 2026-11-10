import type {
  AttributeRenderer,
  InlineEditor,
  InlineRange,
} from "@virgultum/std/inline";
import type { BaseTextAttributes, DeltaInsert } from "@virgultum/store";
import type * as Y from "yjs";
import type { ZodType } from "zod";

export type InlineSpecs<
  TextAttributes extends BaseTextAttributes = BaseTextAttributes,
> = {
  name: keyof TextAttributes | string;
  schema: ZodType<Partial<Record<string, unknown>>>;
  match: (delta: DeltaInsert<TextAttributes>) => boolean;
  renderer: AttributeRenderer<TextAttributes>;
  /** A string key groups adjacent attributed text into one atomic range embed. */
  embed?: boolean | ((delta: DeltaInsert<TextAttributes>) => string);
  wrapper?: boolean;
};

export type InlineMarkdownMatchAction<
  // @ts-expect-error We allow to covariance for MyoxusTextAttributes
  in MyoxusTextAttributes extends BaseTextAttributes = BaseTextAttributes,
> = (props: {
  inlineEditor: InlineEditor<MyoxusTextAttributes>;
  prefixText: string;
  inlineRange: InlineRange;
  pattern: RegExp;
  undoManager: Y.UndoManager;
}) => void | boolean;

export type InlineMarkdownMatch<
  MyoxusTextAttributes extends BaseTextAttributes = BaseTextAttributes,
> = {
  name: string;
  pattern: RegExp;
  /** Default space-triggered behavior stays unchanged for existing matchers. */
  trigger?: string;
  /** Semantic spans may contain newlines; derive this prefix from canonical text. */
  fullPrefix?: boolean;
  action: InlineMarkdownMatchAction<MyoxusTextAttributes>;
};
