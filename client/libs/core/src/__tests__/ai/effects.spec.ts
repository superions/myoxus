import { editorEffectElementTags } from "@myoxus/core/editor/ai/effects/registry";
import { describe, expect, test } from "vitest";

describe("ai effects registration split", () => {
  const editorTags = new Set<string>(editorEffectElementTags);

  test("registerAIEditorEffects registers editor widgets only and retires preview custom elements", () => {
    expect(editorTags.has("myoxus-ai-chat")).toBe(true);
    expect(editorTags.has("myoxus-edgeless-copilot-widget")).toBe(true);
    expect(editorTags.has("edgeless-copilot-panel")).toBe(false);
    expect(editorTags.has("myoxus-block-diff-playground")).toBe(false);
    expect(editorTags.has("myoxus-block-diff-widget-for-block")).toBe(false);
    expect(editorTags.has("myoxus-block-diff-widget-for-page")).toBe(false);
    expect(editorTags.has("myoxus-ai-panel-widget")).toBe(false);
    expect(editorTags.has("ai-slides-renderer")).toBe(false);
    expect(editorTags.has("mini-mindmap-preview")).toBe(false);
    expect(editorTags.has("chat-panel")).toBe(false);
    expect(editorTags.has("text-renderer")).toBe(false);
  });
});
