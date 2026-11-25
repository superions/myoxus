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
  ParagraphBlockModel,
  RootBlockModel,
} from "../models/index";
import type { EditorOutlineEntry } from "../services/editor-chrome-host";
import type { BlockModel, Store } from "../store/index";
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
