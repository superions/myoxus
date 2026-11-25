export const sharedEffectElementTags = [] as const;

export type SharedEffectElementTag = (typeof sharedEffectElementTags)[number];

export const storedBlockTags = [
  "myoxus-edgeless-ai-chat",
  "myoxus-ai-chat",
  "transcription-block",
] as const;

export const interactiveEditorTags = [
  "myoxus-block-diff-playground",
  "myoxus-ai-panel-widget",
  "myoxus-edgeless-copilot-widget",
  "myoxus-block-diff-widget-for-block",
  "myoxus-block-diff-widget-for-page",
  "edgeless-copilot-panel",
] as const;

export const editorEffectElementTags = [
  ...storedBlockTags,
  ...interactiveEditorTags,
] as const;

export type EditorEffectElementTag = (typeof editorEffectElementTags)[number];

export const appEffectElementTags = [] as const;

export type AppEffectElementTag = (typeof appEffectElementTags)[number];
