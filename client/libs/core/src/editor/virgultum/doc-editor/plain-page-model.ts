// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BlockModel, Store } from "@virgultum/core/store";
import type { SurfaceBlockModel } from "@virgultum/core/runtime/gfx";
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
  alignment?: "left" | "center" | "right";
};

const marks = new Set(["bold", "italic", "underline", "strike", "code"]);
const canvasPrimitives = new Set([
  "shape",
  "brush",
  "text",
  "connector",
  "group",
]);
function supportedText(text: YText, inlineObjects = true) {
  return text
    .toDelta()
    .every(
      (op: { insert: unknown; attributes?: Record<string, unknown> }) =>
        typeof op.insert === "string" &&
        Object.entries(op.attributes ?? {}).every(([key, value]) =>
          key.startsWith("comment-")
            ? inlineObjects &&
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
              ? inlineObjects &&
                op.insert === " " &&
                DocumentFieldSchema.safeParse(value).success
              : key === "mention"
                ? inlineObjects &&
                  op.insert === " " &&
                  !!value &&
                  typeof value === "object" &&
                  "member" in value &&
                  typeof value.member === "string" &&
                  !!value.member
                : key === "latex"
                  ? inlineObjects &&
                    op.insert === " " &&
                    typeof value === "string"
                  : key === "link"
                    ? inlineObjects && typeof value === "string" && !!value
                    : marks.has(key)
                      ? value === true
                      : key === "reference"
                        ? inlineObjects &&
                          op.insert === " " &&
                          !!value &&
                          typeof value === "object" &&
                          "pageId" in value &&
                          typeof value.pageId === "string" &&
                          "type" in value &&
                          (value.type === "LinkedPage" ||
                            value.type === "Subpage")
                        : key === "footnote"
                          ? inlineObjects &&
                            op.insert === " " &&
                            FootNoteSchema.safeParse(value).success
                          : key === "annotation"
                            ? inlineObjects &&
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

/** Inspect the live tree, including disconnected children during materialization.
 * Unknown runs are never flattened into editable plain text. */
export function readPageContent(page: Store) {
  const root = page.root as RootBlockModel | null;
  if (
    root?.flavour !== "myoxus:page" ||
    !root.props.title?.yText ||
    !supportedText(root.props.title.yText, false)
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
        // The Page projection has no visible block for ordinary Canvas geometry.
        // Inspect the stored types rather than loading painters or editing them;
        // a specialist element or Surface child still requires its own session.
        if (parent !== root || child.yBlock.get("sys:children").length)
          return false;
        const elements = (child as SurfaceBlockModel).elements.getValue();
        if (!elements) return false;
        for (const item of elements.values()) {
          const type = item.get("type");
          if (typeof type !== "string" || !canvasPrimitives.has(type))
            return false;
        }
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
      if (child.flavour === "myoxus:callout" && parent !== root) {
        const model = child as CalloutBlockModel;
        if (
          model.props.textProtection ||
          !supportedText(model.props.text.yText)
        )
          return false;
        const from = body.length;
        if (model.props.text.length || !model.children.length) {
          const line: PageLine = {
            kind: "text",
            model,
            text: model.props.text.yText,
            depth: 0,
            ordinal: 0,
            checked: false,
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
        if (child.yBlock.get("sys:children").length) return false;
        body.push({ kind: "divider", model: child, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:document-index" && parent !== root) {
        if (child.yBlock.get("sys:children").length) return false;
        body.push({
          kind: "directory",
          model: child as DocumentIndexBlockModel,
          depth,
        });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:latex" && parent !== root) {
        const model = child as LatexBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          Object.keys(model.props.comments ?? {}).length
        )
          return false;
        body.push({ kind: "equation", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:database" && parent !== root) {
        const model = child as DatabaseBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          !model.props.serverDatabaseId?.trim()
        )
          return false;
        body.push({ kind: "database", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:event" && parent !== root) {
        if (child.yBlock.get("sys:children").length) return false;
        body.push({ kind: "event", model: child as EventBlockModel, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:annotation" && parent !== root) {
        if (child.yBlock.get("sys:children").length) return false;
        body.push({
          kind: "annotation",
          model: child as AnnotationBlockModel,
          depth,
        });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:attachment" && parent !== root) {
        const model = child as AttachmentBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          model.props.caption ||
          model.props.footnoteIdentifier ||
          Object.keys(model.props.comments ?? {}).length ||
          (model.props.style &&
            !["cubeThick", "horizontalThin", "pdf", "video"].includes(
              model.props.style,
            )) ||
          model.props.type.startsWith("image/")
        )
          return false;
        body.push({ kind: "attachment", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:bookmark" && parent !== root) {
        const model = child as BookmarkBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          model.props.caption ||
          model.props.footnoteIdentifier ||
          model.props.style === "citation" ||
          Object.keys(model.props.comments ?? {}).length
        )
          return false;
        body.push({ kind: "bookmark", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:embed-github" && parent !== root) {
        const model = child as EmbedGithubModel;
        if (model.props.caption || child.yBlock.get("sys:children").length)
          return false;
        body.push({ kind: "forge", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:embed-html" && parent !== root) {
        const model = child as EmbedHtmlModel;
        if (model.props.caption || child.yBlock.get("sys:children").length)
          return false;
        body.push({ kind: "html", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:image" && parent !== root) {
        const model = child as ImageBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          Object.keys(model.props.comments ?? {}).length
        )
          return false;
        body.push({ kind: "image", model, depth });
        ordinal = 0;
        continue;
      }
      if (
        (child.flavour === "myoxus:embed-linked-doc" ||
          child.flavour === "myoxus:embed-synced-doc") &&
        parent !== root
      ) {
        const model = child as EmbedLinkedDocModel | EmbedSyncedDocModel;
        if (
          child.yBlock.get("sys:children").length ||
          !model.props.pageId ||
          model.props.caption ||
          model.props.style === "citation" ||
          ("preFoldHeight" in model.props && model.props.preFoldHeight)
        )
          return false;
        body.push({ kind: "document", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:embed-iframe" && parent !== root) {
        const model = child as EmbedIframeBlockModel;
        if (child.yBlock.get("sys:children").length || model.props.caption)
          return false;
        body.push({ kind: "iframe", model, depth });
        ordinal = 0;
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
        if (
          child.yBlock.get("sys:children").length ||
          model.props.caption ||
          !["video", "figma"].includes(model.props.style)
        )
          return false;
        body.push({ kind: "player", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:table" && parent !== root) {
        const model = child as TableBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          !Object.keys(model.props.rows).length ||
          !Object.keys(model.props.columns).length ||
          Object.keys(model.props.comments ?? {}).length ||
          Object.values(model.props.rows).some((r) => r.repeat) ||
          Object.values(model.props.cells).some(
            (c) =>
              c.textProtection ||
              !c.text?.yText ||
              c.text
                .toDelta()
                .some(
                  (run) =>
                    typeof run.insert !== "string" ||
                    Object.keys(run.attributes ?? {}).length,
                ),
          )
        )
          return false;
        body.push({ kind: "table", model, depth });
        ordinal = 0;
        continue;
      }
      if (child.flavour === "myoxus:code" && parent !== root) {
        const model = child as CodeBlockModel;
        if (
          child.yBlock.get("sys:children").length ||
          model.props.caption ||
          model.props.preview ||
          ["html", "mermaid", "typst"].includes(model.props.language ?? "") ||
          Object.keys(model.props.comments ?? {}).length ||
          model.props.text
            .toDelta()
            .some(
              (d) =>
                typeof d.insert !== "string" ||
                Object.keys(d.attributes ?? {}).length,
            )
        )
          return false;
        body.push({ kind: "code", model, depth });
        ordinal = 0;
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
        (props.collapsed &&
          !props.type.startsWith("h") &&
          child.flavour !== "myoxus:list") ||
        props.repeat ||
        props.textProtection ||
        (props.textAlign &&
          !["left", "center", "right"].includes(props.textAlign)) ||
        (props.comments && Object.keys(props.comments).length) ||
        ("presentation" in props &&
          props.presentation &&
          !(props.presentation === "eyebrow" && props.type === "text"))
      )
        return false;
      const heading =
        m.flavour === "myoxus:paragraph" && /^h[1-6]$/.test(props.type)
          ? (props.type as PageLine["heading"])
          : undefined;
      const kind = heading ? "text" : props.type;
      if (
        kind !== "text" &&
        kind !== "quote" &&
        kind !== "bulleted" &&
        kind !== "numbered" &&
        kind !== "todo"
      )
        return false;
      ordinal =
        kind === "numbered"
          ? (("order" in props ? props.order : null) ?? ordinal + 1)
          : 0;
      const line: PageLine = {
        model: m,
        text: m.text.yText,
        kind,
        depth,
        ordinal,
        checked: "checked" in props && props.checked,
        alignment: props.textAlign,
        eyebrow: "presentation" in props && props.presentation === "eyebrow",
        heading,
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
  if (!children(root, 0) || !body.length) return null;
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
