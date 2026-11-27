// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { useI18n } from "@myoxus/i18n";
import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { localFootnoteInsertionNote } from "@virgultum/core/commands";
import { REFERENCE_NODE } from "@virgultum/core/consts";
import {
  calloutPresentation,
  ListBlockModel,
  ParagraphBlockModel,
  TableModelFlavour,
  type CalloutProps,
  type FootnotePlacement,
} from "@virgultum/core/models";
import { IconType, type EditorSlashOption } from "@virgultum/core/services";
import {
  nanoid,
  Text,
  type BlockModel,
  type DeltaInsert,
  type Store,
} from "@virgultum/core/store";
import {
  createDefaultDoc,
  generateFractionalIndexingKeyBetween,
} from "@virgultum/core/utils";

export type PageSlashI18n = ReturnType<typeof useI18n>;

export type PageSlashEmbedKind =
  "bookmark" | "youtube" | "github" | "figma" | "loom";

export type PageSlashActionResult = { id: string; offset: number } | void;

export type PageSlashHostCallbacks = {
  readonly store: Store;
  readonly model: BlockModel;
  readonly offset: number;
  readonly canUseServerDatabase: boolean;
  readonly enableMermaid: boolean;
  readonly enableAI: boolean;
  readonly isTemplateDocument: boolean;
  readonly openLinkPicker: () => void;
  readonly openInlineLink: () => void;
  readonly openEmbedModal: (kind: PageSlashEmbedKind) => void;
  readonly openIframeBlock: () => void;
  readonly openImageUpload: () => void;
  readonly openAttachmentUpload: (pdfOnly: boolean) => void;
  readonly openEventDialog: () => void;
  readonly openDirectoryModal: () => void;
  readonly openFootnoteMenu: (placement: FootnotePlacement) => void;
  readonly openTemplateVariablePicker: () => void;
  readonly openBuildingBlockPicker: () => void;
  readonly insertNamedBuildingBlock: (slug: string) => void;
  readonly openTaskCardCreate: () => void;
  readonly openEmbedExistingDatabase: () => void;
  readonly createServerTable: () => void;
  readonly createServerProject: () => void;
  readonly insertMermaidDiagram: (templateId: string, label: string) => void;
  readonly insertBpmnDiagram: () => void;
  readonly copyLine: () => void;
  readonly openAiPrompt: (prompt?: string) => void;
};

export type PageSlashEntry = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly shortcut?: string;
  readonly icon?: MyoxusIconExportName;
  readonly group: string;
  readonly groupOrder: number;
  readonly itemOrder: number;
  readonly aliases?: readonly string[];
  /** Runs synchronously inside the single-step slash undo transaction. */
  readonly runSync?: (
    store: Store,
    model: BlockModel,
    offset: number,
  ) => PageSlashActionResult;
  /** Runs after `/query` has been removed (modals, uploads, async RPCs). */
  readonly runAsync?: () => void;
  readonly subMenu?: readonly PageSlashEntry[];
};

const CALLOUT_PRESET_TYPES = [
  "note",
  "abstract",
  "info",
  "todo",
  "tip",
  "success",
  "question",
  "warning",
  "failure",
  "danger",
  "bug",
  "example",
  "quote",
] as const satisfies readonly CalloutProps["type"][];

const COMMON_CALLOUT_TYPES = new Set<string>([
  "note",
  "info",
  "tip",
  "warning",
]);

const MERMAID_TEMPLATE_ENTRIES = [
  { id: "c4-basic", label: "C4" },
  { id: "architecture-basic", label: "Architecture" },
  { id: "block-basic", label: "Block" },
  { id: "class-basic", label: "Class" },
  { id: "class-v2-basic", label: "Class v2" },
  { id: "er-basic", label: "Entity Relationship" },
  { id: "flowchart-basic", label: "Flowchart" },
  { id: "flowchart-elk-basic", label: "Flowchart ELK" },
  { id: "gantt-basic", label: "Gantt" },
  { id: "gitgraph-basic", label: "GitGraph" },
  { id: "journey-basic", label: "User Journey" },
  { id: "kanban-basic", label: "Kanban" },
  { id: "mindmap-basic", label: "Mindmap" },
  { id: "packet-basic", label: "Packet" },
  { id: "pie-basic", label: "Pie" },
  { id: "quadrant-basic", label: "Quadrant" },
  { id: "radar-basic", label: "Radar" },
  { id: "requirement-basic", label: "Requirement" },
  { id: "sankey-basic", label: "Sankey" },
  { id: "sequence-basic", label: "Sequence" },
  { id: "state-basic", label: "State" },
  { id: "state-legacy-basic", label: "State (legacy)" },
  { id: "timeline-basic", label: "Timeline" },
  { id: "treemap-basic", label: "Treemap" },
  { id: "xychart-basic", label: "XY chart" },
] as const;

const TEXT_COLOR_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "grey",
] as const;

const HIGHLIGHT_NAMES = ["yellow", "green", "pink", "orange", "blue"] as const;

const LABEL_TONES = [
  "neutral",
  "info",
  "positive",
  "warning",
  "danger",
  "accent",
  "clear",
] as const;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatIsoDate(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatClockTime(date: Date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Convert a paragraph/list block in place or across flavours inside one Store transaction. */
function convertTextBlock(
  store: Store,
  model: BlockModel,
  flavour: "myoxus:paragraph" | "myoxus:list" | "myoxus:code",
  props: Record<string, unknown>,
  offset: number,
): PageSlashActionResult {
  if (model.flavour === flavour) {
    store.updateBlock(model, props);
    if (flavour === "myoxus:paragraph" && props.type !== "text") {
      store.updateBlock(model, () => {
        Reflect.deleteProperty(model.props, "presentation");
      });
    }
    return { id: model.id, offset };
  }
  const parent = store.getParent(model);
  if (!parent) return;
  const index = parent.children.indexOf(model);
  if (index < 0) return;
  const delta = (model.text?.toDelta() ?? []) as DeltaInsert[];
  const text =
    flavour === "myoxus:code"
      ? new Text(model.text?.toString() ?? "")
      : new Text(delta);
  const nextId = store.addBlock(flavour, { ...props, text }, parent, index);
  const nextModel = store.getModelById(nextId);
  if (nextModel && flavour !== "myoxus:code" && model.children.length) {
    store.moveBlocks([...model.children], nextModel);
  }
  store.deleteBlock(model);
  return { id: nextId, offset: Math.min(offset, text.length) };
}

function formatWholeLine(
  model: BlockModel,
  attrs: Record<string, unknown>,
  offset: number,
): PageSlashActionResult {
  if (!model.text || !model.text.length) return { id: model.id, offset };
  model.text.format(0, model.text.length, attrs);
  return { id: model.id, offset };
}

export function resolveInsertParent(
  store: Store,
  model: BlockModel,
  flavour: string,
): { parent: BlockModel; anchor: BlockModel; index: number } | null {
  let anchor: BlockModel | null = model;
  let parent = store.getParent(anchor);
  while (parent) {
    if (store.schema.safeValidate(flavour, parent.flavour, [])) {
      const index = parent.children.indexOf(anchor);
      if (index >= 0) return { parent, anchor, index };
    }
    anchor = parent;
    parent = store.getParent(anchor);
  }
  return null;
}

function insertSiblingBlock(
  store: Store,
  model: BlockModel,
  flavour: string,
  props: Record<string, unknown>,
  removeIfEmpty = true,
): string | null {
  const target = resolveInsertParent(store, model, flavour);
  if (!target) return null;
  const blockId = store.addBlock(
    flavour,
    props,
    target.parent,
    target.index + 1,
  );
  if (
    removeIfEmpty &&
    target.anchor === model &&
    model.text?.yText.length === 0 &&
    model.children.length === 0
  ) {
    store.deleteBlock(model);
  }
  return blockId;
}

export function buildPageSlashItems(
  t: PageSlashI18n,
  host: PageSlashHostCallbacks,
): PageSlashEntry[] {
  const { store, model } = host;
  const hasFlavour = (flavour: string) =>
    store.schema.flavourSchemaMap.has(flavour);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const basicGroup = t["com.myoxus.editor.group.basic"]();
  const listGroup = t["com.myoxus.editor.group.list"]();
  const alignGroup = t["com.myoxus.editor.group.align"]();
  const styleGroup = t["com.myoxus.editor.group.style"]();
  const pageGroup = t["Page"]();
  const calloutGroup = t["com.myoxus.editor.group.callouts"]();
  const contentGroup = t["com.myoxus.editor.group.content-media"]();
  const diagramsGroup = t["com.myoxus.workspaceSubPath.diagrams"]();
  const dateGroup = t["Date"]();
  const databaseGroup = t["com.myoxus.editor.group.database"]();
  const actionGroup = t["com.myoxus.actions"]();

  const items: PageSlashEntry[] = [];

  // ── Basic ───────────────────────────────────────────────────────────────
  if (hasFlavour("myoxus:paragraph")) {
    items.push(
      {
        id: "block-paragraph-text",
        label: t["Text"](),
        description: t["com.myoxus.editor.slash.text-description"](),
        icon: "TextIcon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 0,
        aliases: ["text", "paragraph"],
        runSync: (s, m, o) =>
          convertTextBlock(s, m, "myoxus:paragraph", { type: "text" }, o),
      },
      {
        id: "block-paragraph-h1",
        label: t["Heading"]({ number: "1" }),
        description: t["com.myoxus.editor.slash.heading-description"]({
          number: "largest",
        }),
        icon: "Heading1Icon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 1,
        aliases: ["h1", "heading 1"],
        runSync: (s, m, o) =>
          convertTextBlock(s, m, "myoxus:paragraph", { type: "h1" }, o),
      },
      {
        id: "block-paragraph-h2",
        label: t["Heading"]({ number: "2" }),
        description: t["com.myoxus.editor.slash.heading-description"]({
          number: "2nd",
        }),
        icon: "Heading2Icon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 2,
        aliases: ["h2", "heading 2"],
        runSync: (s, m, o) =>
          convertTextBlock(s, m, "myoxus:paragraph", { type: "h2" }, o),
      },
      {
        id: "block-paragraph-h3",
        label: t["Heading"]({ number: "3" }),
        description: t["com.myoxus.editor.slash.heading-description"]({
          number: "3rd",
        }),
        icon: "Heading3Icon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 3,
        aliases: ["h3", "heading 3"],
        runSync: (s, m, o) =>
          convertTextBlock(s, m, "myoxus:paragraph", { type: "h3" }, o),
      },
      {
        id: "block-paragraph-other-headings",
        label: t["com.myoxus.editor.slash.other-headings"](),
        icon: "HeadingsIcon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 4,
        aliases: ["headings", "h4", "h5", "h6"],
        subMenu: (
          [
            ["h4", "4", "4th", "Heading4Icon"],
            ["h5", "5", "5th", "Heading5Icon"],
            ["h6", "6", "6th", "Heading6Icon"],
          ] as const
        ).map(([type, num, ord, icon], idx) => ({
          id: `block-paragraph-${type}`,
          label: t["Heading"]({ number: num }),
          description: t["com.myoxus.editor.slash.heading-description"]({
            number: ord,
          }),
          icon,
          group: basicGroup,
          groupOrder: 0,
          itemOrder: idx,
          aliases: [type, `heading ${num}`],
          runSync: (s, m, o) =>
            convertTextBlock(s, m, "myoxus:paragraph", { type }, o),
        })),
      },
    );
  }

  if (hasFlavour("myoxus:code")) {
    items.push({
      id: "block-code-insert",
      label: t["com.myoxus.editor.slash.code-block"](),
      description: t["com.myoxus.editor.slash.code-block-description"](),
      icon: "CodeBlockIcon",
      group: basicGroup,
      groupOrder: 0,
      itemOrder: 5,
      aliases: ["code", "code block"],
      runSync: (s, m, o) => convertTextBlock(s, m, "myoxus:code", {}, o),
    });
  }

  if (hasFlavour("myoxus:paragraph")) {
    items.push({
      id: "block-paragraph-quote",
      label: t["com.myoxus.editor.keyboard.quote"](),
      description: t["com.myoxus.editor.slash.quote-description"](),
      icon: "QuoteIcon",
      group: basicGroup,
      groupOrder: 0,
      itemOrder: 6,
      aliases: ["quote", "blockquote"],
      runSync: (s, m, o) =>
        convertTextBlock(s, m, "myoxus:paragraph", { type: "quote" }, o),
    });
  }

  if (hasFlavour("myoxus:divider")) {
    items.push({
      id: "block-divider-insert",
      label: t["Divider"](),
      description: t["com.myoxus.editor.slash.divider-description"](),
      icon: "DividerIcon",
      group: basicGroup,
      groupOrder: 0,
      itemOrder: 7,
      aliases: ["divider", "hr", "separator"],
      runSync: (s, m) => {
        const target = resolveInsertParent(s, m, "myoxus:divider");
        if (!target) return;
        s.addBlock("myoxus:divider", {}, target.parent, target.index + 1);
        const nextId = s.addBlock(
          "myoxus:paragraph",
          {},
          target.parent,
          target.index + 2,
        );
        if (
          target.anchor === m &&
          m.text?.yText.length === 0 &&
          m.children.length === 0
        )
          s.deleteBlock(m);
        return { id: nextId, offset: 0 };
      },
    });
  }

  if (model instanceof ParagraphBlockModel && model.props.type === "text") {
    items.push({
      id: "block-paragraph-eyebrow",
      label: t["com.myoxus.editor.paragraph.eyebrow"](),
      icon: "TextTypeIcon",
      group: basicGroup,
      groupOrder: 0,
      itemOrder: 8,
      aliases: ["eyebrow", "small-heading"],
      runSync: (s, m, o) => {
        const current = (m.props as { presentation?: string }).presentation;
        if (current === "eyebrow") {
          s.updateBlock(m, () => {
            Reflect.deleteProperty(m.props, "presentation");
          });
        } else {
          s.updateBlock(m, { presentation: "eyebrow" });
        }
        return { id: m.id, offset: o };
      },
    });
  }

  if (hasFlavour("myoxus:latex")) {
    items.push({
      id: "block-inline-equation-insert",
      label: t["com.myoxus.editor.slash.inline-equation"](),
      description: t["com.myoxus.editor.slash.inline-equation-description"](),
      icon: "TeXIcon",
      group: basicGroup,
      groupOrder: 0,
      itemOrder: 9,
      aliases: ["inline equation", "latex", "math"],
      runSync: (_s, m, o) => {
        if (!m.text) return;
        m.text.insert(" ", o, { latex: "" });
        return { id: m.id, offset: o + 1 };
      },
    });
  }

  if (hasFlavour("myoxus:annotation")) {
    items.push({
      id: "block-annotation-insert",
      label: t["com.myoxus.editor.annotation"](),
      icon: "FileTextIcon",
      group: basicGroup,
      groupOrder: 0,
      itemOrder: 10,
      aliases: ["annotation", "annotate"],
      runSync: (s, m) => {
        insertSiblingBlock(s, m, "myoxus:annotation", {}, true);
      },
    });
  }

  if (
    hasFlavour("myoxus:footnote-definition") &&
    localFootnoteInsertionNote(store, model)
  ) {
    items.push(
      {
        id: "local-footnote-insert",
        label: t["com.myoxus.editor.footnote"](),
        icon: "FileTextIcon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 11,
        aliases: ["footnote"],
        runAsync: () => host.openFootnoteMenu("footnote"),
      },
      {
        id: "local-endnote-insert",
        label: t["com.myoxus.editor.endnote"](),
        icon: "FileTextIcon",
        group: basicGroup,
        groupOrder: 0,
        itemOrder: 12,
        aliases: ["endnote"],
        runAsync: () => host.openFootnoteMenu("endnote"),
      },
    );
  }

  // ── Lists ───────────────────────────────────────────────────────────────
  if (hasFlavour("myoxus:list")) {
    items.push(
      {
        id: "block-list-bulleted",
        label: t["com.myoxus.editor.slash.bulleted-list"](),
        description: t["com.myoxus.editor.slash.bulleted-list-description"](),
        icon: "BulletedListIcon",
        group: listGroup,
        groupOrder: 1,
        itemOrder: 0,
        aliases: ["bullet", "bulleted list", "ul"],
        runSync: (s, m, o) =>
          convertTextBlock(s, m, "myoxus:list", { type: "bulleted" }, o),
      },
      {
        id: "block-list-numbered",
        label: t["com.myoxus.editor.slash.numbered-list"](),
        description: t["com.myoxus.editor.slash.numbered-list-description"](),
        icon: "NumberedListIcon",
        group: listGroup,
        groupOrder: 1,
        itemOrder: 1,
        aliases: ["numbered", "numbered list", "ol"],
        runSync: (s, m, o) =>
          convertTextBlock(s, m, "myoxus:list", { type: "numbered" }, o),
      },
      {
        id: "block-list-todo",
        label: t["com.myoxus.editor.slash.todo-list"](),
        description: t["com.myoxus.editor.slash.todo-list-description"](),
        icon: "CheckBoxCheckLinearIcon",
        group: listGroup,
        groupOrder: 1,
        itemOrder: 2,
        aliases: [
          "todo",
          "to-do",
          "checkbox",
          t["com.myoxus.editor.slash.todo-alias"](),
        ],
        runSync: (s, m, o) =>
          convertTextBlock(
            s,
            m,
            "myoxus:list",
            { type: "todo", checked: false },
            o,
          ),
      },
    );
  }

  // ── Align & Style ───────────────────────────────────────────────────────
  if (model.flavour === "myoxus:paragraph" || model.flavour === "myoxus:list") {
    items.push(
      {
        id: "block-align-left",
        label: t["com.myoxus.keyboardShortcuts.alignLeft"](),
        icon: "TextAlignLeftIcon",
        group: alignGroup,
        groupOrder: 2,
        itemOrder: 0,
        aliases: ["align left"],
        runSync: (s, m, o) => {
          s.updateBlock(m, { textAlign: "left" });
          return { id: m.id, offset: o };
        },
      },
      {
        id: "block-align-center",
        label: t["com.myoxus.keyboardShortcuts.alignCenter"](),
        icon: "TextAlignCenterIcon",
        group: alignGroup,
        groupOrder: 2,
        itemOrder: 1,
        aliases: ["align center"],
        runSync: (s, m, o) => {
          s.updateBlock(m, { textAlign: "center" });
          return { id: m.id, offset: o };
        },
      },
      {
        id: "block-align-right",
        label: t["com.myoxus.keyboardShortcuts.alignRight"](),
        icon: "TextAlignRightIcon",
        group: alignGroup,
        groupOrder: 2,
        itemOrder: 2,
        aliases: ["align right"],
        runSync: (s, m, o) => {
          s.updateBlock(m, { textAlign: "right" });
          return { id: m.id, offset: o };
        },
      },
    );
  }

  items.push(
    {
      id: "inline-format-bold",
      label: t["Bold"](),
      icon: "BoldIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 3,
      aliases: ["bold"],
      runSync: (_s, m, o) => formatWholeLine(m, { bold: true }, o),
    },
    {
      id: "inline-format-italic",
      label: t["com.myoxus.editor.keyboard.italic"](),
      icon: "ItalicIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 4,
      aliases: ["italic"],
      runSync: (_s, m, o) => formatWholeLine(m, { italic: true }, o),
    },
    {
      id: "inline-format-underline",
      label: t["com.myoxus.editor.keyboard.underline"](),
      icon: "UnderLineIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 5,
      aliases: ["underline"],
      runSync: (_s, m, o) => formatWholeLine(m, { underline: true }, o),
    },
    {
      id: "inline-format-strike",
      label: t["com.myoxus.keyboardShortcuts.strikethrough"](),
      icon: "StrikeThroughIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 6,
      aliases: ["strike", "strikethrough"],
      runSync: (_s, m, o) => formatWholeLine(m, { strike: true }, o),
    },
    {
      id: "inline-format-code",
      label: t["com.myoxus.editor.slash.inline-code"](),
      icon: "CodeIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 7,
      aliases: ["inline-code", "code"],
      runSync: (_s, m, o) => formatWholeLine(m, { code: true }, o),
    },
    {
      id: "inline-format-link",
      label: t["com.myoxus.editor.slash.text-link"](),
      icon: "LinkIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 8,
      aliases: ["link", "url"],
      runAsync: () => host.openInlineLink(),
    },
    {
      id: "inline-format-text-color",
      label: t["com.myoxus.editor.toolbar.text-color"](),
      icon: "TextColorIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 9,
      aliases: ["text-color", "color"],
      subMenu: [
        {
          id: "inline-format-text-color-default",
          label: t["com.myoxus.editor.keyboard.default-color"](),
          icon: "TextColorIcon",
          group: styleGroup,
          groupOrder: 2,
          itemOrder: 0,
          runSync: (_s, m, o) => formatWholeLine(m, { color: null }, o),
        },
        ...TEXT_COLOR_NAMES.map((name, idx) => ({
          id: `inline-format-text-color-${name}`,
          label: t[`com.myoxus.editor.table.color.${name}`](),
          icon: "TextColorIcon" as const,
          group: styleGroup,
          groupOrder: 2,
          itemOrder: idx + 1,
          aliases: [name, `color ${name}`],
          runSync: (_s: Store, m: BlockModel, o: number) =>
            formatWholeLine(
              m,
              { color: `var(--myoxus-text-highlight-foreground-${name})` },
              o,
            ),
        })),
      ],
    },
    {
      id: "inline-format-highlight",
      label: t["com.myoxus.editor.toolbar.text-marker"](),
      icon: "HighLightLinearIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 10,
      aliases: [
        "highlight",
        "background-color",
        t["com.myoxus.editor.toolbar.background-color"](),
      ],
      subMenu: [
        {
          id: "inline-format-highlight-default",
          label: t["com.myoxus.editor.toolbar.remove-text-marker"](),
          icon: "HighLightLinearIcon",
          group: styleGroup,
          groupOrder: 2,
          itemOrder: 0,
          runSync: (_s, m, o) => formatWholeLine(m, { background: null }, o),
        },
        ...HIGHLIGHT_NAMES.map((name, idx) => ({
          id: `inline-format-highlight-${name}`,
          label: t[`com.myoxus.editor.text-marker.${name}`](),
          icon: "HighLightLinearIcon" as const,
          group: styleGroup,
          groupOrder: 2,
          itemOrder: idx + 1,
          aliases: [name, `highlight ${name}`],
          runSync: (_s: Store, m: BlockModel, o: number) =>
            formatWholeLine(
              m,
              { background: `var(--myoxus-sem-text-marker-${name})` },
              o,
            ),
        })),
      ],
    },
    {
      id: "inline-format-label-tone",
      label: t["com.myoxus.editor.label-tone.label"](),
      icon: "TagsIcon",
      group: styleGroup,
      groupOrder: 2,
      itemOrder: 11,
      aliases: ["label-tone", "tone"],
      subMenu: LABEL_TONES.map((tone, idx) => ({
        id: `inline-format-label-tone-${tone}`,
        label: t[`com.myoxus.editor.label-tone.${tone}`](),
        icon: "TagsIcon" as const,
        group: styleGroup,
        groupOrder: 2,
        itemOrder: idx,
        aliases: [tone],
        runSync: (_s, m, o) =>
          formatWholeLine(m, { labelTone: tone === "clear" ? null : tone }, o),
      })),
    },
  );

  // ── Page & Callouts ─────────────────────────────────────────────────────
  if (hasFlavour("myoxus:embed-linked-doc")) {
    items.push(
      {
        id: "block-linked-doc-create",
        label: t["com.myoxus.editor.slash.linked-doc-new"](),
        description: t["com.myoxus.editor.slash.linked-doc-new-description"](),
        icon: "PlusIcon",
        group: pageGroup,
        groupOrder: 3,
        itemOrder: 0,
        aliases: ["new doc", "new page"],
        runSync: (s, m, o) => {
          if (!m.text) return;
          const newDoc = createDefaultDoc(s.workspace);
          m.text.insert(REFERENCE_NODE, o, {
            reference: { type: "LinkedPage", pageId: newDoc.id },
          });
          return { id: m.id, offset: o + REFERENCE_NODE.length };
        },
      },
      {
        id: "block-linked-doc-existing",
        label: t["com.myoxus.editor.slash.linked-doc-existing"](),
        description:
          t["com.myoxus.editor.slash.linked-doc-existing-description"](),
        icon: "LinkedPageIcon",
        group: pageGroup,
        groupOrder: 3,
        itemOrder: 1,
        aliases: [
          "linked",
          "link document",
          t["com.myoxus.editor.slash.linked-doc-alias"](),
        ],
        runAsync: () => host.openLinkPicker(),
      },
    );
  }

  if (hasFlavour("myoxus:callout")) {
    const calloutEntries: PageSlashEntry[] = CALLOUT_PRESET_TYPES.map(
      (type, idx) => {
        const presetLabel = t[`com.myoxus.editor.callout.preset.${type}`]();
        const label =
          type === "note"
            ? t["com.myoxus.editor.slash.callout"]()
            : presetLabel;
        return {
          id:
            type === "note"
              ? "block-callout-insert"
              : `block-callout-${type}-insert`,
          label,
          description: t["com.myoxus.editor.slash.callout-description"](),
          icon: "MegaphoneIcon",
          group: calloutGroup,
          groupOrder: 3,
          itemOrder: idx,
          aliases: [
            `callout-${type}`,
            `callout ${type}`,
            type,
            presetLabel,
            ...(type === "note"
              ? ["callout", t["com.myoxus.editor.slash.callout-alias"]()]
              : []),
          ],
          runSync: (s, m) => {
            const target = resolveInsertParent(s, m, "myoxus:callout");
            if (!target) return;
            const presentation = calloutPresentation(type);
            const calloutId = s.addBlock(
              "myoxus:callout",
              {
                type,
                icon: { type: IconType.Emoji, unicode: presentation.icon },
                backgroundColorName: presentation.background,
              },
              target.parent,
              target.index + 1,
            );
            const paragraphId = s.addBlock("myoxus:paragraph", {}, calloutId);
            if (
              target.anchor === m &&
              m.text?.yText.length === 0 &&
              m.children.length === 0
            )
              s.deleteBlock(m);
            return { id: paragraphId, offset: 0 };
          },
        };
      },
    );
    items.push(
      ...calloutEntries.filter((entry) =>
        COMMON_CALLOUT_TYPES.has(
          entry.id === "block-callout-insert"
            ? "note"
            : entry.id.replace("block-callout-", "").replace("-insert", ""),
        ),
      ),
      {
        id: "block-callout-more",
        label: t["com.myoxus.editor.callout.more"](),
        icon: "MegaphoneIcon",
        group: calloutGroup,
        groupOrder: 3,
        itemOrder: CALLOUT_PRESET_TYPES.length,
        aliases: ["callout"],
        subMenu: calloutEntries.filter(
          (entry) =>
            !COMMON_CALLOUT_TYPES.has(
              entry.id === "block-callout-insert"
                ? "note"
                : entry.id.replace("block-callout-", "").replace("-insert", ""),
            ),
        ),
      },
    );
  }

  // ── Content & Media ─────────────────────────────────────────────────────
  if (hasFlavour(TableModelFlavour)) {
    items.push({
      id: "block-table-insert",
      label: t["com.myoxus.editor.slash.table"](),
      description: t["com.myoxus.editor.slash.table-description"](),
      icon: "TableIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 0,
      aliases: ["table"],
      runSync: (s, m) => {
        const r1 = nanoid();
        const r2 = nanoid();
        const c1 = nanoid();
        const c2 = nanoid();
        const ro1 = generateFractionalIndexingKeyBetween(null, null);
        const ro2 = generateFractionalIndexingKeyBetween(ro1, null);
        const co1 = generateFractionalIndexingKeyBetween(null, null);
        const co2 = generateFractionalIndexingKeyBetween(co1, null);
        insertSiblingBlock(
          s,
          m,
          TableModelFlavour,
          {
            headerRows: 1,
            rows: {
              [r1]: { rowId: r1, order: ro1 },
              [r2]: { rowId: r2, order: ro2 },
            },
            columns: {
              [c1]: { columnId: c1, order: co1, width: 280 },
              [c2]: { columnId: c2, order: co2, width: 280 },
            },
            cells: {
              [`${r1}:${c1}`]: { text: new Text() },
              [`${r1}:${c2}`]: { text: new Text() },
              [`${r2}:${c1}`]: { text: new Text() },
              [`${r2}:${c2}`]: { text: new Text() },
            },
          },
          true,
        );
      },
    });
  }

  if (hasFlavour("myoxus:image")) {
    items.push({
      id: "block-image-insert",
      label: t["Image"](),
      description: t["com.myoxus.editor.slash.image-description"](),
      icon: "ImageIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 1,
      aliases: ["image", "photo", "picture"],
      runAsync: () => host.openImageUpload(),
    });
  }

  if (hasFlavour("myoxus:bookmark")) {
    items.push({
      id: "block-bookmark-insert",
      label: t["Link"](),
      description: t["com.myoxus.editor.slash.bookmark-description"](),
      icon: "LinkIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 2,
      aliases: ["bookmark", "link"],
      runAsync: () => host.openEmbedModal("bookmark"),
    });
  }

  if (hasFlavour("myoxus:attachment")) {
    items.push(
      {
        id: "block-attachment-insert",
        label: t["com.myoxus.editor.slash.attachment"](),
        description: t["com.myoxus.editor.slash.attachment-description"](),
        icon: "FileIcon",
        group: contentGroup,
        groupOrder: 4,
        itemOrder: 3,
        aliases: ["attachment", "file"],
        runAsync: () => host.openAttachmentUpload(false),
      },
      {
        id: "block-attachment-pdf",
        label: t["com.myoxus.editor.slash.pdf"](),
        description: t["com.myoxus.editor.slash.pdf-description"](),
        icon: "ExportToPdfIcon",
        group: contentGroup,
        groupOrder: 4,
        itemOrder: 4,
        aliases: ["pdf"],
        runAsync: () => host.openAttachmentUpload(true),
      },
    );
  }

  if (hasFlavour("myoxus:embed-iframe")) {
    items.push({
      id: "block-embed-iframe",
      label: t["com.myoxus.editor.slash.embed"](),
      description: t["com.myoxus.editor.slash.embed-description"](),
      icon: "EmbedIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 5,
      aliases: ["embed", "iframe"],
      runAsync: () => host.openIframeBlock(),
    });
  }

  if (hasFlavour("myoxus:embed-youtube")) {
    items.push({
      id: "block-embed-youtube",
      label: t["com.myoxus.editor.slash.youtube"](),
      description: t["com.myoxus.editor.slash.youtube-description"](),
      icon: "YoutubeDuotoneIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 6,
      aliases: ["youtube", "video"],
      runAsync: () => host.openEmbedModal("youtube"),
    });
  }

  if (hasFlavour("myoxus:embed-github")) {
    items.push({
      id: "block-embed-github",
      label: t["com.myoxus.editor.slash.github"](),
      description: t["com.myoxus.editor.slash.github-description"](),
      icon: "CodeIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 7,
      aliases: ["github", "gitlab", "forgejo", "issue", "pr"],
      runAsync: () => host.openEmbedModal("github"),
    });
  }

  if (hasFlavour("myoxus:embed-figma")) {
    items.push({
      id: "block-embed-figma",
      label: t["com.myoxus.editor.slash.figma"](),
      description: t["com.myoxus.editor.slash.figma-description"](),
      icon: "FigmaDuotoneIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 8,
      aliases: ["figma"],
      runAsync: () => host.openEmbedModal("figma"),
    });
  }

  if (hasFlavour("myoxus:embed-loom")) {
    items.push({
      id: "block-embed-loom",
      label: t["com.myoxus.editor.slash.loom"](),
      description: t["com.myoxus.editor.slash.loom-description"](),
      icon: "LoomLogoDuotoneIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 9,
      aliases: ["loom"],
      runAsync: () => host.openEmbedModal("loom"),
    });
  }

  if (hasFlavour("myoxus:event")) {
    items.push({
      id: "block-event-insert",
      label: t["com.myoxus.editor.slash.event"](),
      description: t["com.myoxus.editor.slash.event-description"](),
      icon: "CalendarClockIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 10,
      aliases: ["event", "calendar"],
      runAsync: () => host.openEventDialog(),
    });
  }

  if (hasFlavour("myoxus:document-index")) {
    items.push(
      {
        id: "block-document-index-insert",
        label: t["com.myoxus.wiki.directory.title"](),
        description: t["com.myoxus.wiki.directory.description"](),
        icon: "BulletedListIcon",
        group: contentGroup,
        groupOrder: 4,
        itemOrder: 11,
        aliases: [
          "wiki",
          "directory",
          "index",
          "Seitenverzeichnis",
          "Register",
        ],
        runAsync: () => host.openDirectoryModal(),
      },
      {
        id: "block-page-report-insert",
        label: t["com.myoxus.wiki.report.title"](),
        icon: "TableIcon",
        group: contentGroup,
        groupOrder: 4,
        itemOrder: 12,
        aliases: ["wiki", "report", "Seitenbericht", "Metadatenbericht"],
        runAsync: () => host.insertNamedBuildingBlock("block-page-report"),
      },
    );
  }

  if (hasFlavour("myoxus:latex")) {
    items.push({
      id: "block-equation-insert",
      label: t["com.myoxus.editor.slash.equation"](),
      description: t["com.myoxus.editor.slash.equation-description"](),
      icon: "TeXIcon",
      group: contentGroup,
      groupOrder: 4,
      itemOrder: 13,
      aliases: [
        "equation",
        "latex",
        "math",
        t["com.myoxus.editor.slash.equation-alias"](),
      ],
      runSync: (s, m) => {
        insertSiblingBlock(s, m, "myoxus:latex", { latex: "" }, true);
      },
    });
  }

  // ── Diagrams ────────────────────────────────────────────────────────────
  if (hasFlavour("myoxus:bpmn")) {
    items.push({
      id: "bpmn",
      label: t["com.myoxus.editor.bpmn.slash-name"](),
      description: t["com.myoxus.editor.bpmn.slash-description"](),
      icon: "WorkflowIcon",
      group: diagramsGroup,
      groupOrder: 5,
      itemOrder: 2,
      aliases: ["bpmn", "process", "workflow", "diagramm", "prozess"],
      runAsync: () => host.insertBpmnDiagram(),
    });
  }

  if (host.enableMermaid && hasFlavour("myoxus:mermaid")) {
    items.push({
      id: "mermaid",
      label: t["com.myoxus.editor.mermaid.slash-name"](),
      description: t["com.myoxus.editor.mermaid.toolbar-search-placeholder"](),
      icon: "WorkflowIcon",
      group: diagramsGroup,
      groupOrder: 5,
      itemOrder: 3,
      aliases: [
        "mermaid",
        "diagram",
        "diagramm",
        "flowchart",
        "sequence",
        "gantt",
        "gitgraph",
      ],
      subMenu: MERMAID_TEMPLATE_ENTRIES.map((template, idx) => ({
        id: `mermaid-${template.id}`,
        label: `Mermaid: ${template.label}`,
        description: t["com.myoxus.editor.mermaid.slash-description"](),
        icon: "WorkflowIcon",
        group: diagramsGroup,
        groupOrder: 5,
        itemOrder: idx,
        aliases: ["mermaid", "diagram", "diagramm", template.label],
        runAsync: () => host.insertMermaidDiagram(template.id, template.label),
      })),
    });
  }

  // ── Date & Time ─────────────────────────────────────────────────────────
  items.push(
    {
      id: "action-today",
      label: t["com.myoxus.common.calendar.today"](),
      description: formatIsoDate(now),
      icon: "TodayIcon",
      group: dateGroup,
      groupOrder: 6,
      itemOrder: 0,
      aliases: ["today", "date"],
      runSync: (_s, m, o) => {
        if (!m.text) return;
        const text = formatIsoDate(new Date());
        m.text.insert(text, o);
        return { id: m.id, offset: o + text.length };
      },
    },
    {
      id: "action-tomorrow",
      label: t["com.myoxus.tomorrow"](),
      description: formatIsoDate(tomorrow),
      icon: "TomorrowIcon",
      group: dateGroup,
      groupOrder: 6,
      itemOrder: 1,
      aliases: ["tomorrow", "date"],
      runSync: (_s, m, o) => {
        if (!m.text) return;
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const text = formatIsoDate(d);
        m.text.insert(text, o);
        return { id: m.id, offset: o + text.length };
      },
    },
    {
      id: "action-yesterday",
      label: t["com.myoxus.yesterday"](),
      description: formatIsoDate(yesterday),
      icon: "YesterdayIcon",
      group: dateGroup,
      groupOrder: 6,
      itemOrder: 2,
      aliases: ["yesterday", "date"],
      runSync: (_s, m, o) => {
        if (!m.text) return;
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const text = formatIsoDate(d);
        m.text.insert(text, o);
        return { id: m.id, offset: o + text.length };
      },
    },
    {
      id: "action-now",
      label: t["com.myoxus.time.now"](),
      description: formatClockTime(now),
      icon: "NowIcon",
      group: dateGroup,
      groupOrder: 6,
      itemOrder: 3,
      aliases: ["now", "time"],
      runSync: (_s, m, o) => {
        if (!m.text) return;
        const text = formatClockTime(new Date());
        m.text.insert(text, o);
        return { id: m.id, offset: o + text.length };
      },
    },
  );

  // ── Database ────────────────────────────────────────────────────────────
  if (host.canUseServerDatabase && hasFlavour("myoxus:database")) {
    items.push(
      {
        id: "task-card-create",
        label: t["com.myoxus.database.tasks.new"](),
        description: t["com.myoxus.database.tasks.embed-description"](),
        icon: "CheckBoxCheckSolidIcon",
        group: databaseGroup,
        groupOrder: 7,
        itemOrder: 1,
        aliases: ["task", "aufgabe", "tâche", "tarea"],
        runAsync: () => host.openTaskCardCreate(),
      },
      {
        id: "server-database-embed-existing",
        label: t["com.myoxus.database.slash.embed-existing"](),
        description:
          t["com.myoxus.database.slash.embed-existing.description"](),
        icon: "DatabaseIcon",
        group: databaseGroup,
        groupOrder: 7,
        itemOrder: 3,
        aliases: ["database", "embed database"],
        runAsync: () => host.openEmbedExistingDatabase(),
      },
      {
        id: "server-database-create-table",
        label: t["com.myoxus.database.slash.new-table"](),
        description: t["com.myoxus.database.slash.new-table.description"](),
        icon: "DatabaseTableViewIcon",
        group: databaseGroup,
        groupOrder: 7,
        itemOrder: 4,
        aliases: ["database", "server table"],
        runAsync: () => host.createServerTable(),
      },
      {
        id: "server-database-create-project",
        label: t["com.myoxus.database.slash.new-project"](),
        description: t["com.myoxus.database.slash.new-project.description"](),
        icon: "DatabaseIcon",
        group: databaseGroup,
        groupOrder: 7,
        itemOrder: 5,
        aliases: ["database", "project"],
        runAsync: () => host.createServerProject(),
      },
    );
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  items.push(
    {
      id: "action-move-up",
      label: t["com.myoxus.editor.slash.move-up"](),
      description: t["com.myoxus.editor.slash.move-up-description"](),
      icon: "ArrowUpBigIcon",
      group: actionGroup,
      groupOrder: 8,
      itemOrder: 0,
      aliases: ["move up"],
      runSync: (s, m, o) => {
        const prev = s.getPrev(m);
        const parent = prev && s.getParent(prev);
        if (!prev || !parent) return;
        s.moveBlocks([m], parent, prev, true);
        return { id: m.id, offset: o };
      },
    },
    {
      id: "action-move-down",
      label: t["com.myoxus.editor.slash.move-down"](),
      description: t["com.myoxus.editor.slash.move-down-description"](),
      icon: "ArrowDownBigIcon",
      group: actionGroup,
      groupOrder: 8,
      itemOrder: 1,
      aliases: ["move down"],
      runSync: (s, m, o) => {
        const next = s.getNext(m);
        const parent = next && s.getParent(next);
        if (!next || !parent) return;
        s.moveBlocks([m], parent, next, false);
        return { id: m.id, offset: o };
      },
    },
    {
      id: "action-copy",
      label: t["Copy"](),
      description: t["com.myoxus.editor.slash.copy-description"](),
      icon: "CopyIcon",
      group: actionGroup,
      groupOrder: 8,
      itemOrder: 2,
      aliases: ["copy"],
      runAsync: () => host.copyLine(),
    },
    {
      id: "action-duplicate",
      label: t["com.myoxus.header.option.duplicate"](),
      description: t["com.myoxus.editor.slash.duplicate-description"](),
      icon: "DualLinkIcon",
      group: actionGroup,
      groupOrder: 8,
      itemOrder: 3,
      aliases: ["duplicate"],
      runSync: (s, m) => {
        if (!m.text) return;
        const parent = s.getParent(m);
        if (!parent) return;
        const index = parent.children.indexOf(m);
        if (index < 0) return;
        const extraProps: Record<string, unknown> = {
          text: new Text(m.text.toDelta() as DeltaInsert[]),
        };
        if (m instanceof ParagraphBlockModel) extraProps.type = m.props.type;
        if (m instanceof ListBlockModel) {
          extraProps.type = m.props.type;
          extraProps.checked = m.props.checked;
        }
        const id = s.addBlock(m.flavour, extraProps, parent, index + 1);
        return { id, offset: m.text.length };
      },
    },
    {
      id: "action-delete",
      label: t["Delete"](),
      description: t["com.myoxus.editor.slash.delete-description"](),
      icon: "DeleteIcon",
      group: actionGroup,
      groupOrder: 8,
      itemOrder: 4,
      aliases: [
        "delete",
        "remove",
        t["com.myoxus.editor.slash.remove-alias"](),
      ],
      runSync: (s, m) => {
        const parent = s.getParent(m);
        const next = s.getNext(m) ?? s.getPrev(m);
        const isSoleNoteChild =
          parent?.flavour === "myoxus:note" && parent.children.length === 1;
        s.deleteBlock(m);
        if (isSoleNoteChild && parent) {
          const freshId = s.addBlock("myoxus:paragraph", {}, parent, 0);
          return { id: freshId, offset: 0 };
        }
        if (next?.text) return { id: next.id, offset: 0 };
        return;
      },
    },
  );

  if (model.flavour === "myoxus:paragraph" || model.flavour === "myoxus:list") {
    items.push({
      id: "action-insert-document-field",
      label: t["com.myoxus.editor.field.document-fields"](),
      icon: "TextTypeIcon",
      group: actionGroup,
      groupOrder: 8,
      itemOrder: 5,
      aliases: ["field", "variable", "document field", "template"],
      runAsync: () => host.openTemplateVariablePicker(),
    });
  }

  items.push({
    id: "action-insert-building-block",
    label: t["com.myoxus.templates.blocks.insert"](),
    icon: "TemplateIcon",
    group: actionGroup,
    groupOrder: 8,
    itemOrder: 6,
    aliases: ["building block", "template", "snippet"],
    runAsync: () => host.openBuildingBlockPicker(),
  });

  // ── Myoxus AI (only when AI is enabled) ─────────────────────────────────
  if (host.enableAI) {
    const aiGroup = "Myoxus AI";
    items.push({
      id: "ai-ask",
      label: t["com.myoxus.editor.toolbar.ask-ai"](),
      icon: "AiIcon",
      group: aiGroup,
      groupOrder: 1,
      itemOrder: 0,
      aliases: ["ai", "ask ai", "copilot"],
      runAsync: () => host.openAiPrompt(),
    });
  }

  items.sort((a, b) =>
    a.groupOrder !== b.groupOrder
      ? a.groupOrder - b.groupOrder
      : a.itemOrder - b.itemOrder,
  );
  return items;
}

export function scorePageSlashItem(
  item: PageSlashEntry,
  query: string,
  locale?: string,
): number {
  const normalize = (value: string) => value.toLocaleLowerCase(locale);
  const needle = normalize(query.trim());
  if (!needle) return 0;
  const matchTerm = (candidate: string, term: string) => {
    const text = normalize(candidate);
    if (text === term) return 4;
    if (text.startsWith(term)) return 3.25;
    if (text.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(term))) return 3;
    if (text.includes(term)) return 2;
    return 0;
  };
  const labelScore = matchTerm(item.label, needle);
  const bestAlias = Math.max(
    0,
    ...(item.aliases ?? []).map((alias) => matchTerm(alias, needle)),
    matchTerm(item.id, needle),
  );
  const direct = Math.max(labelScore ? labelScore + 0.5 : 0, bestAlias);
  if (direct > 0) return direct;

  // Support multi-word and punctuated queries like "/mermaid elk" or
  // "/mermaid-elk" where tokens match across label, aliases, and id without
  // outranking direct contiguous substring matches (minimum score 2.0).
  const tokens = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length < 2) return 0;
  const fields = [item.label, ...(item.aliases ?? []), item.id];
  let total = 0;
  for (const token of tokens) {
    const tokenScore = Math.max(
      0,
      ...fields.map((field) => matchTerm(field, token)),
    );
    if (tokenScore === 0) return 0;
    total += tokenScore;
  }
  return (total / tokens.length) * 0.45;
}

/** Flatten nested submenus during search so typing `/h5` or `/gantt` matches directly. */
export function filterPageSlashItems(
  items: readonly PageSlashEntry[],
  query: string,
  locale?: string,
): PageSlashEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];
  const flattened: PageSlashEntry[] = [];
  const collect = (list: readonly PageSlashEntry[]) => {
    for (const item of list) {
      if (item.subMenu?.length) {
        collect(item.subMenu);
      } else {
        flattened.push(item);
      }
    }
  };
  collect(items);
  return flattened
    .map((item) => ({ item, score: scorePageSlashItem(item, trimmed, locale) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.item.groupOrder !== b.item.groupOrder
          ? a.item.groupOrder - b.item.groupOrder
          : a.item.itemOrder - b.item.itemOrder,
    )
    .map(({ item }) => item);
}

export function toEditorSlashOption(entry: PageSlashEntry): EditorSlashOption {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    shortcut: entry.shortcut,
    icon: entry.icon,
    group: entry.group,
    submenu: Boolean(entry.subMenu?.length),
  };
}
