// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BlockModel, Store } from "@virgultum/core/store";
import type {
  RootBlockModel,
  NoteBlockModel,
  ParagraphBlockModel,
  ListBlockModel,
} from "@virgultum/core/models";
import type { Text as YText } from "yjs";

export type PageLine = {
  model: BlockModel;
  text: YText;
  kind: "title" | "text" | "bulleted" | "numbered" | "todo";
  depth: number;
  ordinal: number;
  checked: boolean;
};

const marks = new Set(["bold", "italic", "underline", "strike", "code"]);
function supportedText(text: YText) {
  return text
    .toDelta()
    .every(
      (op: { insert: unknown; attributes?: Record<string, unknown> }) =>
        typeof op.insert === "string" &&
        Object.entries(op.attributes ?? {}).every(([key, value]) =>
          marks.has(key)
            ? value === true
            : (key === "color" || key === "background") &&
              typeof value === "string" &&
              /^var\(--myoxus-[\w-]+\)$/.test(value),
        ),
    );
}

/** Inspect the live tree, including disconnected children during materialization.
 * Unknown runs are never flattened into editable plain text. */
export function plainPageLines(page: Store): PageLine[] | null {
  const root = page.root as RootBlockModel | null;
  if (
    root?.flavour !== "myoxus:page" ||
    !root.props.title?.yText ||
    !supportedText(root.props.title.yText)
  )
    return null;
  const lines: PageLine[] = [
    {
      model: root,
      text: root.props.title.yText,
      kind: "title",
      depth: 0,
      ordinal: 0,
      checked: false,
    },
  ];
  const seen = new Set([root.id]);
  function children(parent: BlockModel, depth: number): boolean {
    const models = parent.children;
    if (models.length !== parent.yBlock.get("sys:children").length)
      return false;
    let ordinal = 0;
    for (const child of models) {
      if (seen.has(child.id)) return false;
      seen.add(child.id);
      if (child.flavour === "myoxus:surface") {
        if (parent !== root || !child.isEmpty() || child.children.length)
          return false;
        continue;
      }
      if (child.flavour === "myoxus:note") {
        const note = child as NoteBlockModel;
        if (
          parent !== root ||
          note.props.hidden ||
          note.props.displayMode === "edgeless" ||
          (note.props.comments && Object.keys(note.props.comments).length)
        )
          return false;
        if (!children(note, depth)) return false;
        continue;
      }
      if (
        parent === root ||
        (child.flavour !== "myoxus:paragraph" &&
          child.flavour !== "myoxus:list")
      )
        return false;
      const m = child as ParagraphBlockModel | ListBlockModel;
      const props = m.props;
      if (
        !m.text ||
        !supportedText(m.text.yText) ||
        props.collapsed ||
        props.repeat ||
        props.textProtection ||
        (props.textAlign && props.textAlign !== "left") ||
        (props.comments && Object.keys(props.comments).length) ||
        ("presentation" in props && props.presentation)
      )
        return false;
      const kind = props.type;
      if (
        kind !== "text" &&
        kind !== "bulleted" &&
        kind !== "numbered" &&
        kind !== "todo"
      )
        return false;
      ordinal =
        kind === "numbered"
          ? (("order" in props ? props.order : null) ?? ordinal + 1)
          : 0;
      lines.push({
        model: m,
        text: m.text.yText,
        kind,
        depth,
        ordinal,
        checked: "checked" in props && props.checked,
      });
      if (!children(child, depth + 1)) return false;
    }
    return true;
  }
  return children(root, 0) && lines.length > 1 ? lines : null;
}
