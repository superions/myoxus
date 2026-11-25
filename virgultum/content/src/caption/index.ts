import { BlockCaptionEditor } from "./caption-session.js";
export { BlockCaptionEditor } from "./caption-session.js";
export {
  NativeCaptionedBlockComponent,
  SelectedStyle,
  type BlockStyleMap,
} from "./native-captioned-block.js";

export function effects() {
  customElements.define("block-caption-editor", BlockCaptionEditor);
}
