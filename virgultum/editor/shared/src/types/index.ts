import type { Annotation, FootNote, ReferenceInfo } from "@virgultum/model";
import type { InlineEditor } from "@virgultum/std/inline";
import type { BlockModel } from "@virgultum/store";
export * from "./uni-component";

export type NoteChildrenFlavour =
  | "myoxus:annotation"
  | "myoxus:paragraph"
  | "myoxus:list"
  | "myoxus:code"
  | "myoxus:divider"
  | "myoxus:database"
  | "myoxus:data-view"
  | "myoxus:image"
  | "myoxus:bookmark"
  | "myoxus:attachment"
  | "myoxus:surface-ref";

export interface Viewport {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

export type ExtendedModel = BlockModel & Record<string, any>;

export type IndentContext = {
  blockId: string;
  inlineIndex: number;
  flavour: string;
  type: "indent" | "dedent";
};

export type MyoxusTextStyleAttributes = {
  bold?: true | null;
  italic?: true | null;
  underline?: true | null;
  strike?: true | null;
  code?: true | null;
  color?: string | null;
  background?: string | null;
  labelTone?: MyoxusLabelTone | null;
};

export type MyoxusLabelTone =
  "neutral" | "info" | "positive" | "warning" | "danger" | "accent";

export type MyoxusTextAttributes = MyoxusTextStyleAttributes & {
  annotation?: Annotation | null;
  link?: string | null;
  reference?:
    | ({
        type: "Subpage" | "LinkedPage";
      } & ReferenceInfo)
    | null;
  latex?: string | null;
  footnote?: FootNote | null;
  mention?: {
    member: string;
    notification?: string;
  } | null;
  [key: `comment-${string}`]: boolean | null;
};

export type MyoxusInlineEditor = InlineEditor<MyoxusTextAttributes>;

export type SelectedRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  borderWidth: number;
  borderStyle: string;
  rotate: number;
};
