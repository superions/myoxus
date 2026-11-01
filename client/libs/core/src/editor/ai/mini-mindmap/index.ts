// SPDX-License-Identifier: AGPL-3.0-or-later
import { MiniMindmapPreview } from "./mindmap-preview.js";
export { markdownToMindmap, MiniMindmapPreview } from "./mindmap-preview.js";
export function registerMiniMindmapBlocks() {
  customElements.define("mini-mindmap-preview", MiniMindmapPreview);
}
