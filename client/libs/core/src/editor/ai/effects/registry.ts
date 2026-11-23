export const sharedEffectElementTags = [
  "ai-error-wrapper",
  "ai-slides-renderer",
  "chat-content-images",
  "chat-content-pure-text",
  "chat-content-rich-text",
  "chat-content-stream-objects",
  "text-renderer",
  "doc-compose-tool",
  "code-artifact-tool",
  "code-highlighter",
  "artifact-preview-panel",
] as const;

export type SharedEffectElementTag = (typeof sharedEffectElementTags)[number];

export const editorEffectElementTags = [
  "myoxus-edgeless-ai-chat",
  "myoxus-ai-chat",
  "ai-scrollable-text-renderer",
  "ai-block-diff-options",
  "myoxus-block-diff-playground",
  "myoxus-block-diff-playground-modal",
  "myoxus-ai-panel-widget",
  "myoxus-edgeless-copilot-widget",
  "myoxus-block-diff-widget-for-block",
  "myoxus-block-diff-widget-for-page",
  "edgeless-copilot-panel",
  "transcription-block",
] as const;

export type EditorEffectElementTag = (typeof editorEffectElementTags)[number];

export const appEffectElementTags = [
  "ai-loading",
  "ai-chat-content",
  "ai-chat-messages",
  "ai-chat-input",
  "ai-chat-composer",
  "chat-panel-chips",
  "ai-history-clear",
  "chat-assistant-avatar",
  "chat-message-assistant",
  "chat-message-user",
] as const;

export type AppEffectElementTag = (typeof appEffectElementTags)[number];
