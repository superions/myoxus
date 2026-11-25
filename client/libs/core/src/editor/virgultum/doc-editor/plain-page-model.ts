// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BlockModel, Store } from "@virgultum/core/store";
import type {
  RootBlockModel,
  NoteBlockModel,
  ParagraphBlockModel,
  ListBlockModel,
  DocumentIndexBlockModel,
  LatexBlockModel,
  DatabaseBlockModel,
  EventBlockModel,
  AttachmentBlockModel,
  TableBlockModel,
  AnnotationBlockModel,
  BookmarkBlockModel,
  FootnoteDefinitionBlockModel,
  CodeBlockModel,
  CalloutBlockModel,
  EmbedFigmaModel,
  EmbedIframeBlockModel,
  EmbedGithubModel,
  EmbedHtmlModel,
  ImageBlockModel,
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
  EmbedLoomModel,
  EmbedYoutubeModel,
  MermaidBlockModel,
  BpmnBlockModel,
  TemplateRepeatBinding,
} from "@virgultum/core/models";
import type { Text as YText } from "yjs";
import { isMyoxusLabelTone } from "@virgultum/core/styles/text";
import { DocumentFieldSchema } from "@virgultum/core/types";
import { FootNoteSchema } from "@virgultum/core/models/footnote";

export type PageLine = {
  model: BlockModel;
  text: YText;
  kind: "title" | "text" | "quote" | "bulleted" | "numbered" | "todo";
  eyebrow?: boolean;
  heading?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  depth: number;
  ordinal: number;
  checked: boolean;
  alignment?: "left" | "center" | "right" | "justify";
  textProtection?: "source" | "fixed";
  repeat?: TemplateRepeatBinding;
  comments?: Record<string, boolean>;
};

const marks = new Set(["bold", "italic", "underline", "strike", "code"]);
export function supportedText(
  text: YText,
  inlineObjects: boolean | "source-fields" | "snapshot" = true,
) {
  const allowObjects = inlineObjects === true || inlineObjects === "snapshot";
  const allowFields =
    inlineObjects === true ||
    inlineObjects === "source-fields" ||
    inlineObjects === "snapshot";
  return text
    .toDelta()
    .every(
      (op: { insert: unknown; attributes?: Record<string, unknown> }) =>
        typeof op.insert === "string" &&
        Object.entries(op.attributes ?? {}).every(([key, value]) =>
          key.startsWith("comment-")
            ? allowObjects &&
              key.length > 8 &&
              typeof value === "boolean" &&
              ![
                "reference",
                "documentField",
                "annotation",
                "footnote",
                "mention",
                "latex",
                "link",
              ].some((k) => Object.hasOwn(op.attributes ?? {}, k))
            : key === "documentField"
              ? allowFields &&
                op.insert === " " &&
                DocumentFieldSchema.safeParse(value).success
              : key === "documentFieldCaptured"
                ? value === true
                : key === "mention"
                  ? allowObjects &&
                    op.insert === " " &&
                    !!value &&
                    typeof value === "object" &&
                    "member" in value &&
                    typeof value.member === "string" &&
                    !!value.member
                  : key === "latex"
                    ? allowObjects &&
                      op.insert === " " &&
                      typeof value === "string"
                    : key === "link"
                      ? allowObjects && typeof value === "string" && !!value
                      : marks.has(key)
                        ? value === true
                        : key === "reference"
                          ? allowObjects &&
                            op.insert === " " &&
                            !!value &&
                            typeof value === "object" &&
                            "pageId" in value &&
                            typeof value.pageId === "string" &&
                            "type" in value &&
                            (value.type === "LinkedPage" ||
                              value.type === "Subpage")
                          : key === "footnote"
                            ? allowObjects &&
                              op.insert === " " &&
                              FootNoteSchema.safeParse(value).success
                            : key === "annotation"
                              ? allowObjects &&
                                !!value &&
                                typeof value === "object" &&
                                "id" in value &&
                                typeof value.id === "string" &&
                                !!value.id &&
                                Object.keys(value).length === 1
                              : key === "labelTone"
                                ? isMyoxusLabelTone(value)
                                : (key === "color" || key === "background") &&
                                  typeof value === "string" &&
                                  /^var\(--myoxus-[\w-]+\)$/.test(value),
        ),
    );
}

export function readPageTitle(page: Store): PageLine | null {
  const model = page.root as RootBlockModel | null;
  if (model?.flavour !== "myoxus:page" || !model.props.title?.yText)
    return null;
  return {
    model,
    text: model.props.title.yText,
    kind: "title",
    depth: 0,
    ordinal: 0,
    checked: false,
  };
}

/** Snapshot bodies read the captured models across all Page block flavours. */
export function canReadPageSnapshot(
  _content: PageContent,
  _sourceFields = false,
) {
  return true;
}

/** Inspect the live tree, including disconnected children during materialization.
 * Unknown runs are never flattened into editable plain text. */
export function readPageContent(
  page: Store,
  _reader?: "source-fields" | "snapshot",
  allowedIds?: ReadonlySet<string>,
) {
  const title = readPageTitle(page);
  if (!title) return null;
  const root = title.model;
  const lines: PageLine[] = [title];
  const seen = new Set([root.id]);
  type Item =
    | PageLine
    | { kind: "divider"; model: BlockModel; depth: number }
    | { kind: "directory"; model: DocumentIndexBlockModel; depth: number }
    | { kind: "equation"; model: LatexBlockModel; depth: number }
    | { kind: "database"; model: DatabaseBlockModel; depth: number }
    | { kind: "event"; model: EventBlockModel; depth: number }
    | { kind: "attachment"; model: AttachmentBlockModel; depth: number }
    | { kind: "table"; model: TableBlockModel; depth: number }
    | { kind: "annotation"; model: AnnotationBlockModel; depth: number }
    | { kind: "bookmark"; model: BookmarkBlockModel; depth: number }
    | { kind: "footnote"; model: FootnoteDefinitionBlockModel; depth: number }
    | { kind: "code"; model: CodeBlockModel; depth: number }
    | { kind: "image"; model: ImageBlockModel; depth: number }
    | { kind: "mermaid"; model: MermaidBlockModel; depth: number }
    | { kind: "bpmn"; model: BpmnBlockModel; depth: number }
    | { kind: "forge"; model: EmbedGithubModel; depth: number }
    | { kind: "html"; model: EmbedHtmlModel; depth: number }
    | {
        kind: "document";
        model: EmbedLinkedDocModel | EmbedSyncedDocModel;
        depth: number;
      }
    | { kind: "iframe"; model: EmbedIframeBlockModel; depth: number }
    | {
        kind: "player";
        model: EmbedFigmaModel | EmbedLoomModel | EmbedYoutubeModel;
        depth: number;
      }
    | {
        kind: "callout";
        model: CalloutBlockModel;
        depth: number;
        children: Item[];
      };
  const body: Item[] = [];
  function children(parent: BlockModel, depth: number): boolean {
    const models = parent.children;
    if (models.length !== parent.yBlock.get("sys:children").length)
      return false;
    let ordinal = 0;
    // Definitions are end matter of their own note. Sort only their view
    // positions; the physical sibling order and every native ID stay intact.
    const definitions =
      parent.flavour === "myoxus:note"
        ? models.filter((m) => m.flavour === "myoxus:footnote-definition")
        : [];
    const ordered = definitions.length
      ? models.filter((m) => m.flavour !== "myoxus:footnote-definition")
      : models;
    for (const child of ordered) {
      if (seen.has(child.id)) return false;
      seen.add(child.id);
      if (child.flavour === "myoxus:surface") {
        // The Page surface owner indexes this root child but paints none of its
        // geometry or descendants. They remain in the live Store for Canvas.
        if (parent !== root) return false;
        continue;
      }
      if (child.flavour === "myoxus:note") {
        const note = child as NoteBlockModel;
        if (parent !== root) return false;
        if (note.props.displayMode === "edgeless") continue;
        if (!children(note, depth)) return false;
        continue;
      }
      if (allowedIds && !allowedIds.has(child.id)) {
        if (!children(child, depth)) return false;
        continue;
      }
      if (child.flavour === "myoxus:callout" && parent !== root) {
        const model = child as CalloutBlockModel;
        const from = body.length;
        if (
          model.props.text?.yText &&
          (model.props.text.length || !model.children.length)
        ) {
          const line: PageLine = {
            kind: "text",
            model,
            text: model.props.text.yText,
            depth: 0,
            ordinal: 0,
            checked: false,
            textProtection: model.props.textProtection,
          };
          body.push(line);
          lines.push(line);
        }
        if (!children(model, 0)) return false;
        const entries = body.splice(from);
        body.push({ kind: "callout", model, depth, children: entries });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:divider" && parent !== root) {
        body.push({ kind: "divider", model: child, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:document-index" && parent !== root) {
        body.push({
          kind: "directory",
          model: child as DocumentIndexBlockModel,
          depth,
        });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:latex" && parent !== root) {
        const model = child as LatexBlockModel;
        body.push({ kind: "equation", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:database" && parent !== root) {
        const model = child as DatabaseBlockModel;
        body.push({ kind: "database", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:event" && parent !== root) {
        body.push({ kind: "event", model: child as EventBlockModel, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:annotation" && parent !== root) {
        body.push({
          kind: "annotation",
          model: child as AnnotationBlockModel,
          depth,
        });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:attachment" && parent !== root) {
        const model = child as AttachmentBlockModel;
        body.push({ kind: "attachment", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:bookmark" && parent !== root) {
        const model = child as BookmarkBlockModel;
        body.push({ kind: "bookmark", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:embed-github" && parent !== root) {
        const model = child as EmbedGithubModel;
        body.push({ kind: "forge", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:embed-html" && parent !== root) {
        const model = child as EmbedHtmlModel;
        body.push({ kind: "html", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:image" && parent !== root) {
        const model = child as ImageBlockModel;
        body.push({ kind: "image", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (
        (child.flavour === "myoxus:embed-linked-doc" ||
          child.flavour === "myoxus:embed-synced-doc") &&
        parent !== root
      ) {
        const model = child as EmbedLinkedDocModel | EmbedSyncedDocModel;
        if (model.props.pageId) {
          body.push({ kind: "document", model, depth });
        }
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:embed-iframe" && parent !== root) {
        const model = child as EmbedIframeBlockModel;
        body.push({ kind: "iframe", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (
        [
          "myoxus:embed-figma",
          "myoxus:embed-loom",
          "myoxus:embed-youtube",
        ].includes(child.flavour) &&
        parent !== root
      ) {
        const model = child as
          EmbedFigmaModel | EmbedLoomModel | EmbedYoutubeModel;
        body.push({ kind: "player", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:table" && parent !== root) {
        const model = child as TableBlockModel;
        if (
          Object.keys(model.props.rows).length &&
          Object.keys(model.props.columns).length
        ) {
          body.push({ kind: "table", model, depth });
        }
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:code" && parent !== root) {
        const model = child as CodeBlockModel;
        body.push({ kind: "code", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:mermaid" && parent !== root) {
        const model = child as MermaidBlockModel;
        body.push({ kind: "mermaid", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (child.flavour === "myoxus:bpmn" && parent !== root) {
        const model = child as BpmnBlockModel;
        body.push({ kind: "bpmn", model, depth });
        ordinal = 0;
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      if (
        parent === root ||
        (child.flavour !== "myoxus:paragraph" &&
          child.flavour !== "myoxus:list")
      ) {
        // Safely skip unknown or canvas-only block flavours without discarding
        // the rest of the Page document.
        if (child.children.length && !children(child, depth + 1)) return false;
        continue;
      }
      const m = child as ParagraphBlockModel | ListBlockModel;
      const props = m.props;
      if (!m.text) continue;
      const heading =
        m.flavour === "myoxus:paragraph" && /^h[1-6]$/.test(props.type)
          ? (props.type as PageLine["heading"])
          : undefined;
      const kind = heading
        ? "text"
        : props.type === "quote" ||
            props.type === "bulleted" ||
            props.type === "numbered" ||
            props.type === "todo"
          ? props.type
          : "text";
      ordinal =
        kind === "numbered"
          ? (("order" in props ? props.order : null) ?? ordinal + 1)
          : 0;
      const alignment =
        props.textAlign === "left" ||
        props.textAlign === "center" ||
        props.textAlign === "right" ||
        props.textAlign === "justify"
          ? props.textAlign
          : undefined;
      const line: PageLine = {
        model: m,
        text: m.text.yText,
        kind,
        depth,
        ordinal,
        checked: "checked" in props && props.checked,
        alignment,
        eyebrow:
          "presentation" in props &&
          props.presentation === "eyebrow" &&
          props.type === "text",
        heading,
        textProtection: props.textProtection,
        repeat: props.repeat,
        comments: props.comments,
      };
      lines.push(line);
      body.push(line);
      if (!children(child, depth + 1)) return false;
    }
    if (definitions.length) {
      const order = new Map<string, number>();
      for (const line of lines)
        for (const run of line.text.toDelta()) {
          const id = run.attributes?.footnote?.definitionId;
          if (typeof id === "string" && !order.has(id))
            order.set(id, order.size);
        }
      for (const definition of definitions.sort(
        (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
      )) {
        if (seen.has(definition.id)) return false;
        seen.add(definition.id);
        if (allowedIds && !allowedIds.has(definition.id)) {
          if (!children(definition, depth)) return false;
          continue;
        }
        body.push({
          kind: "footnote",
          model: definition as FootnoteDefinitionBlockModel,
          depth,
        });
        if (!children(definition, depth)) return false;
      }
    }
    return true;
  }
  if (!children(root, 0)) return null;
  if (!body.some((item) => item.kind === "callout"))
    return { lines, body, order: body };
  // Clipboard and selection use document order even when a host presents nested blocks.
  const order: Item[] = [];
  const visit = (item: Item) => {
    if (item.kind !== "callout") order.push(item);
    else {
      if (item.children[0]?.model !== item.model) order.push(item);
      item.children.forEach(visit);
    }
  };
  body.forEach(visit);
  return { lines, body, order };
}
export type PageContent = NonNullable<ReturnType<typeof readPageContent>>;
