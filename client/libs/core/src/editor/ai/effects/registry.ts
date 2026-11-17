export const sharedEffectElementTags = [
  "ai-error-wrapper",
  "ai-slides-renderer",
  "ai-answer-wrapper",
  "chat-content-images",
  "chat-content-pure-text",
  "chat-content-rich-text",
  "chat-content-stream-objects",
  "text-renderer",
  "doc-semantic-search-result",
  "doc-keyword-search-result",
  "doc-read-result",
  "doc-write-tool",
  "web-crawl-tool",
  "web-search-tool",
  "section-edit-tool",
  "doc-compose-tool",
  "code-artifact-tool",
  "code-highlighter",
  "artifact-preview-panel",
  "doc-edit-tool",
] as const;

export type SharedEffectElementTag = (typeof sharedEffectElementTags)[number];

export const editorEffectElementTags = [
  "ask-ai-panel",
  "myoxus-edgeless-ai-chat",
  "myoxus-ai-chat",
  "ai-chat-block-message",
  "ai-chat-block-messages",
  "ai-scrollable-text-renderer",
  "image-placeholder",
  "chat-image",
  "chat-images",
  "user-info",
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
  "chat-copy-more",
  "ai-loading",
  "ai-chat-content",
  "ai-chat-messages",
  "ai-chat-input",
  "ai-chat-add-context",
  "ai-chat-composer",
  "chat-panel-chips",
  "ai-history-clear",
  "chat-panel-add-popover",
  "chat-input-preference",
  "chat-panel-candidates-popover",
  "chat-panel-doc-chip",
  "chat-panel-chip",
  "chat-assistant-avatar",
  "chat-message-assistant",
  "chat-message-user",
  "ai-chat-block-peek-view",
] as const;

export type AppEffectElementTag = (typeof appEffectElementTags)[number];
