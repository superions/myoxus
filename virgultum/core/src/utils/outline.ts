// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  AttachmentBlockModel,
  BookmarkBlockModel,
  CodeBlockModel,
  ImageBlockModel,
  ListBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
  normalizeTocLevelRange,
  ParagraphBlockModel,
  RootBlockModel,
} from "../models/index";
import type { EditorOutlineEntry } from "../services/editor-chrome-host";
import type { BlockModel, BlockSnapshot, Store } from "../store/index";
import type { MyoxusTextAttributes } from "../types/index";
import { matchModels } from "./model/index";

export const OUTLINE_SETTINGS_KEY = "outlinePanelSettings";

export const OUTLINE_HEADING_TYPES = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const DEFAULT_NOTE_MODES: readonly NoteDisplayMode[] = [
  NoteDisplayMode.DocAndEdgeless,
  NoteDisplayMode.DocOnly,
  NoteDisplayMode.EdgelessOnly,
];

const TEXT_BLOCK_ICONS = {
  text: "TextIcon",
  quote: "QuoteIcon",
  h1: "Heading1Icon",
  h2: "Heading2Icon",
  h3: "Heading3Icon",
  h4: "Heading4Icon",
  h5: "Heading5Icon",
  h6: "Heading6Icon",
  bulleted: "BulletedListIcon",
  numbered: "NumberedListIcon",
  todo: "CheckBoxCheckLinearIcon",
  toggle: "BlockIcon",
} as const;

export type OutlineReferenceResolution = Readonly<{
  text: string;
  docId?: string;
  unavailable?: boolean;
}>;

export interface OutlineDescriptionOptions {
  resolveReference?: (
    pageId: string,
    workspaceId?: string,
  ) => OutlineReferenceResolution;
  resolveMessage?: (key: string, fallback: string) => string;
}

export function getOutlineNotesFromStore(
  store: Store,
  modes: readonly NoteDisplayMode[] = DEFAULT_NOTE_MODES,
): NoteBlockModel[] {
  const rootModel = store.root;
  if (!rootModel) return [];

  const notes: NoteBlockModel[] = [];
  for (const block of rootModel.children) {
    if (!matchModels(block, [NoteBlockModel])) continue;
    if (modes.includes(block.props.displayMode$.value)) {
      notes.push(block);
    }
  }
  return notes;
}

export function isOutlineHeadingBlock(
  block: BlockModel,
): block is ParagraphBlockModel {
  return (
    matchModels(block, [ParagraphBlockModel]) &&
    OUTLINE_HEADING_TYPES.has(block.props.type$.value)
  );
}

export function getOutlineHeadingBlocksFromNote(
  note: NoteBlockModel,
  ignoreEmpty = false,
): ParagraphBlockModel[] {
  const headings: ParagraphBlockModel[] = [];
  const visit = (children: readonly BlockModel[]) => {
    for (const block of children) {
      if (isOutlineHeadingBlock(block)) {
        if (!ignoreEmpty || (block.text && block.text.length > 0)) {
          headings.push(block);
        }
      }
      if (block.children.length > 0) {
        visit(block.children);
      }
    }
  };
  visit(note.children);
  return headings;
}

const PAGE_READABLE_NOTE_MODES: readonly NoteDisplayMode[] = [
  NoteDisplayMode.DocAndEdgeless,
  NoteDisplayMode.DocOnly,
];

const READABLE_OUTLINE_CONTAINER_FLAVOURS = new Set([
  "myoxus:callout",
  "myoxus:paragraph",
  "myoxus:list",
]);

const STOP_OUTLINE_FLAVOURS = new Set([
  "myoxus:annotation",
  "myoxus:footnote-definition",
  "myoxus:database",
  "myoxus:table",
  "myoxus:code",
  "myoxus:table-of-contents",
  "myoxus:document-index",
  "myoxus:surface",
]);

function shouldStopOutlineTraversal(flavour: string): boolean {
  return (
    STOP_OUTLINE_FLAVOURS.has(flavour) || flavour.startsWith("myoxus:embed-")
  );
}

export function getOutlineHeadingLevel(
  block: ParagraphBlockModel,
): number | undefined {
  const type = block.props.type$.value;
  return /^h[1-6]$/.test(type) ? Number(type.slice(1)) : undefined;
}

/**
 * Deterministic readable Page heading traversal shared by the in-body TOC block.
 * Visits only visible Page notes (`DocAndEdgeless`/`DocOnly`, `!hidden`),
 * descends strictly into readable container children (`callout`, `paragraph`,
 * `list`), and stops at annotations, footnote definitions, embeds, databases,
 * tables, code blocks, canvas-only notes, and TOC blocks themselves.
 */
export function getReadablePageHeadingBlocksFromStore(
  store: Store,
  options?: {
    minLevel?: number;
    maxLevel?: number;
    ignoreEmpty?: boolean;
  },
): ParagraphBlockModel[] {
  const rootModel = store.root;
  if (!rootModel) return [];
  const { minLevel, maxLevel } = normalizeTocLevelRange(
    options?.minLevel ?? 1,
    options?.maxLevel ?? 6,
  );
  const ignoreEmpty = options?.ignoreEmpty ?? true;
  const headings: ParagraphBlockModel[] = [];
  const visited = new Set<string>([rootModel.id]);

  const visit = (children: readonly BlockModel[]) => {
    for (const block of children) {
      if (visited.has(block.id)) continue;
      visited.add(block.id);
      if (shouldStopOutlineTraversal(block.flavour)) continue;
      if (isOutlineHeadingBlock(block)) {
        const level = getOutlineHeadingLevel(block);
        if (
          level !== undefined &&
          level >= minLevel &&
          level <= maxLevel &&
          (!ignoreEmpty || (block.text && block.text.length > 0))
        ) {
          headings.push(block);
        }
      }
      if (
        block.children.length > 0 &&
        READABLE_OUTLINE_CONTAINER_FLAVOURS.has(block.flavour)
      ) {
        visit(block.children);
      }
    }
  };

  for (const child of rootModel.children) {
    if (!matchModels(child, [NoteBlockModel])) continue;
    if (child.props.hidden$.value) continue;
    if (!PAGE_READABLE_NOTE_MODES.includes(child.props.displayMode$.value)) {
      continue;
    }
    visited.add(child.id);
    visit(child.children);
  }
  return headings;
}

export function getOutlineHeadingBlocksFromDoc(
  store: Store,
  modes: readonly NoteDisplayMode[] = DEFAULT_NOTE_MODES,
  ignoreEmpty = false,
): ParagraphBlockModel[] {
  const notes = getOutlineNotesFromStore(store, modes);
  return notes.flatMap((note) =>
    getOutlineHeadingBlocksFromNote(note, ignoreEmpty),
  );
}

/**
 * Pure-Store outline projection shared across Page, Canvas and Share/Peek views.
 * Never requires an EditorHost or BlockStdScope.
 */
export function describeOutlineBlockFromStore(
  block: BlockModel,
  options: OutlineDescriptionOptions = {},
): EditorOutlineEntry | undefined {
  const message =
    options.resolveMessage ?? ((_key: string, fallback: string) => fallback);

  if (matchModels(block, [RootBlockModel])) {
    const label = block.props.title$.value.deltas$.value
      .map((delta) => String(delta.insert))
      .join("");
    return label
      ? { id: block.id, label, level: 0, icon: "PageIcon" }
      : undefined;
  }

  if (matchModels(block, [ParagraphBlockModel, ListBlockModel])) {
    const type = block.props.type$.value;
    const segments = block.props.text$.value.deltas$.value.flatMap((delta) => {
      const reference = (delta.attributes as MyoxusTextAttributes | undefined)
        ?.reference;
      if (!reference) return [{ text: String(delta.insert) }];
      if (options.resolveReference) {
        return [
          options.resolveReference(reference.pageId, reference.workspaceId),
        ];
      }
      return [
        {
          text: message(
            "com.myoxus.reference.target-unavailable",
            "Target unavailable",
          ),
          unavailable: true,
        },
      ];
    });
    const label = segments.map((segment) => segment.text).join("");
    return label.trim()
      ? {
          id: block.id,
          label,
          segments,
          level: /^h[1-6]$/.test(type) ? Number(type[1]) - 1 : 0,
          icon: TEXT_BLOCK_ICONS[type],
        }
      : undefined;
  }

  let label: string;
  let icon: EditorOutlineEntry["icon"];
  if (matchModels(block, [BookmarkBlockModel])) {
    label =
      block.props.title$.value ||
      block.props.url$.value ||
      message("Bookmark", "Bookmark");
    icon = "BookmarkIcon";
  } else if (matchModels(block, [CodeBlockModel])) {
    label =
      block.props.language$.value ||
      message("com.myoxus.editor.slash.code-block", "Code Block");
    icon = "CodeBlockIcon";
  } else if (matchModels(block, [ImageBlockModel])) {
    label = block.props.caption$.value || message("Image", "Image");
    icon = "ImageIcon";
  } else if (matchModels(block, [AttachmentBlockModel])) {
    label =
      block.props.name$.value ||
      message("com.myoxus.editor.slash.attachment", "Attachment");
    icon = "AttachmentIcon";
  } else {
    return undefined;
  }

  return { id: block.id, label, level: 0, icon };
}

export interface SnapshotTocEntry {
  id: string;
  level: number;
  label: string;
  slug: string;
}

/**
 * Deterministic ASCII heading slug matching `yjs::table_of_contents::unique_heading_slug`
 * and `public_render` HTML anchors.
 */
export function slugifyHeadingText(title: string): string {
  let base = "";
  let prevDash = false;
  for (const ch of title.trim().toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      base += ch;
      prevDash = false;
    } else if (!prevDash && base.length > 0) {
      base += "-";
      prevDash = true;
    }
  }
  while (base.endsWith("-")) {
    base = base.slice(0, -1);
  }
  return base || "section";
}

export function createHeadingSlugAssigner(): (title: string) => string {
  const counts = new Map<string, number>();
  return (title: string) => {
    const base = slugifyHeadingText(title);
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    return next === 1 ? base : `${base}-${next}`;
  };
}

function extractSnapshotHeadingLabel(
  props: Record<string, unknown>,
  resolveReference?: (
    pageId: string,
    workspaceId?: string,
  ) => string | undefined,
): string {
  const text = props.text as
    | { delta?: Array<{ insert?: unknown; attributes?: MyoxusTextAttributes }> }
    | undefined;
  const delta = Array.isArray(text?.delta) ? text.delta : [];
  let label = "";
  for (const op of delta) {
    const reference = op.attributes?.reference;
    if (reference?.pageId) {
      // Never disclose unverified cached reference titles during static export.
      label +=
        resolveReference?.(reference.pageId, reference.workspaceId) ??
        "Target unavailable";
    } else if (typeof op.insert === "string") {
      label += op.insert;
    }
  }
  return label.trim();
}

/**
 * Collect readable Page headings and deterministic unique slugs from a `BlockSnapshot` tree,
 * matching `getReadablePageHeadingBlocksFromStore` and Rust `public_render` / `yjs::markdown`.
 * Slugs are assigned across all readable heading levels (1..6) before filtering by
 * `minLevel..=maxLevel` so TOC links always match emitted `<h1..h6 id="...">` anchors.
 */
export function collectSnapshotTocEntries(
  rootSnapshot: BlockSnapshot,
  options?: {
    minLevel?: number;
    maxLevel?: number;
    resolveReference?: (
      pageId: string,
      workspaceId?: string,
    ) => string | undefined;
  },
): SnapshotTocEntry[] {
  const { minLevel, maxLevel } = normalizeTocLevelRange(
    options?.minLevel ?? 1,
    options?.maxLevel ?? 6,
  );
  const assignSlug = createHeadingSlugAssigner();
  const allEntries: SnapshotTocEntry[] = [];
  const visited = new Set<string>();

  const visit = (node: BlockSnapshot) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (shouldStopOutlineTraversal(node.flavour)) return;
    if (node.flavour === "myoxus:note") {
      if (
        node.props?.hidden === true ||
        node.props?.displayMode === "edgeless"
      ) {
        return;
      }
      for (const child of node.children ?? []) {
        visit(child);
      }
      return;
    }
    if (node.flavour === "myoxus:page") {
      for (const child of node.children ?? []) {
        if (child.flavour === "myoxus:note") {
          visit(child);
        }
      }
      return;
    }
    if (
      node.flavour === "myoxus:paragraph" &&
      typeof node.props?.type === "string" &&
      /^h[1-6]$/.test(node.props.type)
    ) {
      const level = Number(node.props.type.slice(1));
      const label = extractSnapshotHeadingLabel(
        node.props,
        options?.resolveReference,
      );
      if (label.length > 0) {
        allEntries.push({
          id: node.id,
          level,
          label,
          slug: assignSlug(label),
        });
      }
    }
    if (
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      READABLE_OUTLINE_CONTAINER_FLAVOURS.has(node.flavour)
    ) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  visit(rootSnapshot);
  return allEntries.filter(
    (entry) => entry.level >= minLevel && entry.level <= maxLevel,
  );
}
