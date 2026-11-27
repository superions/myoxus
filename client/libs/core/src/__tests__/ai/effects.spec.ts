import {
  appEffectElementTags,
  editorEffectElementTags,
  sharedEffectElementTags,
} from "@myoxus/core/editor/ai/effects/registry";
import { describe, expect, test } from "vitest";

describe("ai effects registration split", () => {
  const editorTags = new Set<string>([
    ...editorEffectElementTags,
    ...sharedEffectElementTags,
  ]);
  const appTags = new Set<string>([
    ...appEffectElementTags,
    ...sharedEffectElementTags,
  ]);

  test("registerAIEditorEffects registers editor widgets only and retires preview custom elements", () => {
    expect(editorTags.has("myoxus-ai-chat")).toBe(true);
    expect(editorTags.has("myoxus-edgeless-copilot-widget")).toBe(true);
    expect(editorTags.has("myoxus-ai-panel-widget")).toBe(false);
    expect(editorTags.has("ai-slides-renderer")).toBe(false);
    expect(editorTags.has("mini-mindmap-preview")).toBe(false);
    expect(editorTags.has("chat-panel")).toBe(false);
    expect(editorTags.has("text-renderer")).toBe(false);
  });

  test("registerAIAppEffects skips editor-only elements", () => {
    expect(appTags.has("ai-slides-renderer")).toBe(false);
    expect(appTags.has("chat-panel")).toBe(false);
    expect(appTags.has("myoxus-ai-chat")).toBe(false);
    expect(appTags.has("ai-chat-content")).toBe(false);
  });
});
