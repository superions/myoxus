// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { chatI18n } from "../chat-i18n";
import type {
  AttachmentChip,
  ChatChip,
  ChipState,
  CollectionChip,
  DocChip,
  FileChip,
  SelectedContextChip,
  TagChip,
} from "./type";

const STATE_TOOLTIP_KEYS = {
  candidate: "com.myoxus.ai.chat-panel.context-candidate",
  processing: "com.myoxus.ai.chat-panel.context-processing",
  failed: "com.myoxus.ai.chat-panel.context-error",
} as const;

export function getChipTooltip(
  state: ChipState,
  name: string,
  tooltip?: string | null,
): string {
  if (tooltip) return tooltip;
  if (state in STATE_TOOLTIP_KEYS) {
    return chatI18n()[
      STATE_TOOLTIP_KEYS[state as keyof typeof STATE_TOOLTIP_KEYS]
    ]();
  }
  return name;
}

export function isDocChip(chip: ChatChip): chip is DocChip {
  return "docId" in chip;
}

export function isFileChip(chip: ChatChip): chip is FileChip {
  return "file" in chip && chip.file instanceof File;
}

export function isTagChip(chip: ChatChip): chip is TagChip {
  return "tagId" in chip;
}

export function isCollectionChip(chip: ChatChip): chip is CollectionChip {
  return "collectionId" in chip;
}

export function isSelectedContextChip(
  chip: ChatChip,
): chip is SelectedContextChip {
  return "snapshot" in chip && "combinedElementsMarkdown" in chip;
}

export function isAttachmentChip(chip: ChatChip): chip is AttachmentChip {
  return "sourceId" in chip && "name" in chip;
}

export function getChipKey(chip: ChatChip): string | null {
  if (isDocChip(chip)) return chip.docId;
  if (isFileChip(chip)) return chip.file.name;
  if (isTagChip(chip)) return chip.tagId;
  if (isCollectionChip(chip)) return chip.collectionId;
  if (isSelectedContextChip(chip)) return chip.uuid;
  if (isAttachmentChip(chip)) return chip.sourceId;
  return null;
}

function isSameChip(a: ChatChip, b: ChatChip): boolean {
  if (isDocChip(a) && isDocChip(b)) return a.docId === b.docId;
  if (isFileChip(a) && isFileChip(b)) return a.file === b.file;
  if (isTagChip(a) && isTagChip(b)) return a.tagId === b.tagId;
  if (isCollectionChip(a) && isCollectionChip(b)) {
    return a.collectionId === b.collectionId;
  }
  if (isSelectedContextChip(a) && isSelectedContextChip(b)) {
    return a.uuid === b.uuid;
  }
  if (isAttachmentChip(a) && isAttachmentChip(b)) {
    return a.sourceId === b.sourceId;
  }
  return false;
}

export function omitChip(chips: ChatChip[], target: ChatChip): ChatChip[] {
  return chips.filter((chip) => !isSameChip(chip, target));
}

export function findChipIndex(chips: ChatChip[], target: ChatChip): number {
  return chips.findIndex((chip) => isSameChip(chip, target));
}

export function estimateTokenCount(text: string): number {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const nonCjk = text.replace(/[\u4e00-\u9fa5]/g, "").trim();
  const wordCount = nonCjk ? nonCjk.split(/\s+/).length : 0;
  return Math.ceil(cjkChars * 2.5 + wordCount * 1.3);
}
