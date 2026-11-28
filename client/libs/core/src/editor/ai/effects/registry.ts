// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** Custom element tags for persisted AI block views that remain readable in stored documents. */
export const storedBlockTags = [
  "myoxus-edgeless-ai-chat",
  "myoxus-ai-chat",
  "transcription-block",
] as const;

/** Custom element tags for active Edgeless AI editor widgets. */
export const interactiveEditorTags = [
  "myoxus-edgeless-copilot-widget",
] as const;

export const editorEffectElementTags = [
  ...storedBlockTags,
  ...interactiveEditorTags,
] as const;

export type EditorEffectElementTag = (typeof editorEffectElementTags)[number];
