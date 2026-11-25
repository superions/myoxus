import { AISlidesRenderer } from "../messages/slides-renderer";
import { registerMiniMindmapBlocks } from "../mini-mindmap";
import {
  type SharedEffectElementTag,
  sharedEffectElementTags,
} from "./registry";

const sharedRegistries = new WeakSet<CustomElementRegistry>();
const sharedElements = {
  "ai-slides-renderer": AISlidesRenderer,
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
