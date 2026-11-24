import { ChatContentImages } from "../components/ai-message-content/images";
import { ChatContentRichText } from "../components/ai-message-content/rich-text";
import { ChatContentStreamObjects } from "../components/ai-message-content/stream-objects";
import { ArtifactPreviewPanel } from "../components/ai-tools/artifacts-preview-panel";
import {
  CodeArtifactTool,
  CodeHighlighter,
} from "../components/ai-tools/code-artifact";
import { DocComposeTool } from "../components/ai-tools/doc-compose";
import { TextRenderer } from "../components/text-renderer";
import { AIErrorWrapper } from "../messages/error";
import { AISlidesRenderer } from "../messages/slides-renderer";
import { registerMiniMindmapBlocks } from "../mini-mindmap";
import {
  type SharedEffectElementTag,
  sharedEffectElementTags,
} from "./registry";

const sharedRegistries = new WeakSet<CustomElementRegistry>();
const sharedElements = {
  "ai-error-wrapper": AIErrorWrapper,
  "ai-slides-renderer": AISlidesRenderer,
  "chat-content-images": ChatContentImages,
  "chat-content-rich-text": ChatContentRichText,
  "chat-content-stream-objects": ChatContentStreamObjects,
  "text-renderer": TextRenderer,
  "doc-compose-tool": DocComposeTool,
  "code-artifact-tool": CodeArtifactTool,
  "code-highlighter": CodeHighlighter,
  "artifact-preview-panel": ArtifactPreviewPanel,
} satisfies Record<SharedEffectElementTag, CustomElementConstructor>;

export function registerAISharedEffects() {
  const registry = customElements;
  if (sharedRegistries.has(registry)) return;
  sharedRegistries.add(registry);

  registerMiniMindmapBlocks();

  for (const tag of sharedEffectElementTags) {
    customElements.define(tag, sharedElements[tag]);
  }
}
